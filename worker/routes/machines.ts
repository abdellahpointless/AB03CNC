import { machineProblemAlert, notifyLater } from '../alerts';
import { HttpError, json, optStr, readJson, str } from '../http';
import { bumpStmt, newId, type Ctx } from '../context';
import { FREQUENCIES, type Frequency } from '../fleet';
import { requireMachine } from './fleet';

/*
 * Preventive actions. Every user can mark a check as done, report a problem (on a check or on
 * the machine in general) and mark a problem as fixed. Admins edit the checklists.
 * Every action is written to machine_events so the history shows who did what and when.
 */

interface CheckRow {
  id: string;
  machine_id: string;
  kind: 'CHECK' | 'ISSUE';
  title: string;
  frequency: Frequency | null;
  status: 'OK' | 'PROBLEM';
  note: string | null;
  last_done_at: number | null;
  last_done_by: string | null;
  status_at: number | null;
  status_by: string | null;
  sort: number;
  created_at: number;
}

async function machineParam(ctx: Ctx): Promise<string> {
  return (await requireMachine(ctx.env, ctx.params.machine)).id;
}

/**
 * A user who is responsible for one or more machines may only update those machines;
 * users with no machine assigned (and admins) may update every machine.
 */
async function assertMayUpdate(ctx: Ctx, machine: string): Promise<void> {
  if (ctx.user!.role === 'ADMIN') return;
  const row = await ctx.env.DB.prepare(
    'SELECT COUNT(*) AS total, SUM(CASE WHEN machine_id = ? THEN 1 ELSE 0 END) AS mine FROM machine_owners WHERE user_id = ?',
  )
    .bind(machine, ctx.user!.id)
    .first<{ total: number; mine: number | null }>();
  if (row && row.total > 0 && !row.mine) {
    throw new HttpError(403, `${machine} is locked for you: you are responsible for other machines.`);
  }
}

function frequency(v: unknown): Frequency {
  if (typeof v === 'string' && (FREQUENCIES as string[]).includes(v)) return v as Frequency;
  throw new HttpError(400, 'Frequency must be DAILY, WEEKLY, MONTHLY or QUARTERLY');
}

async function loadCheck(ctx: Ctx, machine: string): Promise<CheckRow> {
  const row = await ctx.env.DB.prepare('SELECT * FROM machine_checks WHERE id = ? AND machine_id = ?')
    .bind(ctx.params.id, machine)
    .first<CheckRow>();
  if (!row) throw new HttpError(404, 'Check not found');
  return row;
}

function eventStmt(ctx: Ctx, machine: string, check: { id: string; title: string } | null, action: string, note: string | null) {
  return ctx.env.DB.prepare(
    'INSERT INTO machine_events (machine_id, check_id, check_title, action, note, username, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(machine, check?.id ?? null, check?.title ?? null, action, note, ctx.user!.username, Date.now());
}

// GET /api/machines -> every check of every machine + the latest events
export async function handleListMachines(ctx: Ctx): Promise<Response> {
  const [checks, events, owners] = await ctx.env.DB.batch([
    ctx.env.DB.prepare('SELECT c.* FROM machine_checks c JOIN machines m ON m.id = c.machine_id AND m.active = 1 ORDER BY c.machine_id, c.sort, c.created_at'),
    ctx.env.DB.prepare('SELECT * FROM machine_events ORDER BY at DESC LIMIT 300'),
    ctx.env.DB.prepare(
      `SELECT o.machine_id, o.user_id, u.username FROM machine_owners o JOIN users u ON u.id = o.user_id
       ORDER BY o.machine_id, u.username COLLATE NOCASE`,
    ),
  ]);
  return json({ checks: checks.results, events: events.results, owners: owners.results, serverTime: Date.now() });
}

// POST /api/machines/:machine/checks/:id/action { action: DONE | PROBLEM | RESOLVE, note? }
export async function handleCheckAction(ctx: Ctx): Promise<Response> {
  const machine = await machineParam(ctx);
  await assertMayUpdate(ctx, machine);
  const check = await loadCheck(ctx, machine);
  const body = await readJson<{ action?: unknown; note?: unknown }>(ctx.request, 5000);
  const now = Date.now();
  const user = ctx.user!.username;
  const db = ctx.env.DB;
  let note: string | null = null;
  const stmts: D1PreparedStatement[] = [];

  switch (body.action) {
    case 'DONE':
      if (check.kind !== 'CHECK') throw new HttpError(400, 'Only checklist items can be marked as done');
      note = optStr(body.note, 'Note', 300);
      stmts.push(db.prepare('UPDATE machine_checks SET last_done_at = ?, last_done_by = ? WHERE id = ?').bind(now, user, check.id));
      break;
    case 'PROBLEM':
      note = str(body.note, 'Problem description', { min: 3, max: 300 });
      stmts.push(
        db.prepare("UPDATE machine_checks SET status = 'PROBLEM', note = ?, status_at = ?, status_by = ? WHERE id = ?").bind(note, now, user, check.id),
      );
      break;
    case 'RESOLVE':
      note = optStr(body.note, 'Note', 300);
      stmts.push(
        check.kind === 'ISSUE'
          ? db.prepare('DELETE FROM machine_checks WHERE id = ?').bind(check.id)
          : db.prepare("UPDATE machine_checks SET status = 'OK', note = NULL, status_at = ?, status_by = ? WHERE id = ?").bind(now, user, check.id),
      );
      break;
    default:
      throw new HttpError(400, 'Action must be DONE, PROBLEM or RESOLVE');
  }
  stmts.push(eventStmt(ctx, machine, check, body.action as string, note), bumpStmt(ctx.env, 'machines'));
  await db.batch(stmts);
  if (body.action === 'PROBLEM') {
    const a = machineProblemAlert(ctx.env.REGION, await machineName(ctx, machine), `${check.title}${note && note !== check.title ? ` — ${note}` : ''}`, user);
    await notifyLater(ctx, 'machineProblem', a.message, a.call, `${machine}:${check.id}`);
  }
  return json({ ok: true });
}

// POST /api/machines/:machine/issues { note } -> a problem with the machine that isn't on the checklist
export async function handleReportIssue(ctx: Ctx): Promise<Response> {
  const machine = await machineParam(ctx);
  await assertMayUpdate(ctx, machine);
  const body = await readJson<{ note?: unknown }>(ctx.request, 5000);
  const note = str(body.note, 'Problem description', { min: 3, max: 300 });
  const id = newId();
  const now = Date.now();
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `INSERT INTO machine_checks (id, machine_id, kind, title, frequency, status, note, status_at, status_by, sort, created_at)
       VALUES (?, ?, 'ISSUE', ?, NULL, 'PROBLEM', ?, ?, ?, 0, ?)`,
    ).bind(id, machine, note, note, now, ctx.user!.username, now),
    eventStmt(ctx, machine, { id, title: note }, 'PROBLEM', note),
    bumpStmt(ctx.env, 'machines'),
  ]);
  const a = machineProblemAlert(ctx.env.REGION, await machineName(ctx, machine), note, ctx.user!.username);
  await notifyLater(ctx, 'machineProblem', a.message, a.call, `${machine}:${id}`);
  return json({ ok: true, id });
}

// Admin: POST /api/machines/:machine/checks { title, frequency }
export async function handleCreateCheck(ctx: Ctx): Promise<Response> {
  const machine = await machineParam(ctx);
  const body = await readJson<{ title?: unknown; frequency?: unknown }>(ctx.request, 5000);
  const title = str(body.title, 'Title', { min: 3, max: 160 });
  const freq = frequency(body.frequency);
  const max = await ctx.env.DB.prepare('SELECT COALESCE(MAX(sort), 0) AS s FROM machine_checks WHERE machine_id = ?').bind(machine).first<{ s: number }>();
  const id = newId();
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `INSERT INTO machine_checks (id, machine_id, kind, title, frequency, sort, created_at) VALUES (?, ?, 'CHECK', ?, ?, ?, ?)`,
    ).bind(id, machine, title, freq, (max?.s ?? 0) + 10, Date.now()),
    eventStmt(ctx, machine, { id, title }, 'CHECK_ADDED', null),
    bumpStmt(ctx.env, 'machines'),
  ]);
  return json({ ok: true, id });
}

// Admin: PATCH /api/machines/:machine/checks/:id { title?, frequency? }
export async function handleUpdateCheck(ctx: Ctx): Promise<Response> {
  const machine = await machineParam(ctx);
  const check = await loadCheck(ctx, machine);
  if (check.kind !== 'CHECK') throw new HttpError(400, 'Only checklist items can be edited');
  const body = await readJson<{ title?: unknown; frequency?: unknown }>(ctx.request, 5000);
  const title = body.title === undefined ? check.title : str(body.title, 'Title', { min: 3, max: 160 });
  const freq = body.frequency === undefined ? check.frequency : frequency(body.frequency);
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('UPDATE machine_checks SET title = ?, frequency = ? WHERE id = ?').bind(title, freq, check.id),
    eventStmt(ctx, machine, { id: check.id, title }, 'CHECK_EDITED', null),
    bumpStmt(ctx.env, 'machines'),
  ]);
  return json({ ok: true });
}

// Admin: DELETE /api/machines/:machine/checks/:id
export async function handleDeleteCheck(ctx: Ctx): Promise<Response> {
  const machine = await machineParam(ctx);
  const check = await loadCheck(ctx, machine);
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('DELETE FROM machine_checks WHERE id = ?').bind(check.id),
    eventStmt(ctx, machine, { id: check.id, title: check.title }, 'CHECK_REMOVED', null),
    bumpStmt(ctx.env, 'machines'),
  ]);
  return json({ ok: true });
}

// Admin: PUT /api/machines/:machine/owners { userIds: string[] } -> replaces who is responsible
export async function handleSetOwners(ctx: Ctx): Promise<Response> {
  const machine = await machineParam(ctx);
  const body = await readJson<{ userIds?: unknown }>(ctx.request, 20_000);
  if (!Array.isArray(body.userIds) || body.userIds.length > 100 || !body.userIds.every((x) => typeof x === 'string' && x.length <= 64)) {
    throw new HttpError(400, 'userIds must be a list of user ids');
  }
  const ids = [...new Set(body.userIds as string[])];
  let names: string[] = [];
  if (ids.length) {
    const { results } = await ctx.env.DB.prepare(
      `SELECT id, username FROM users WHERE id IN (${ids.map(() => '?').join(',')})`,
    )
      .bind(...ids)
      .all<{ id: string; username: string }>();
    if (results.length !== ids.length) throw new HttpError(400, 'Unknown user in the list');
    names = results.map((r) => r.username).sort();
  }
  const now = Date.now();
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('DELETE FROM machine_owners WHERE machine_id = ?').bind(machine),
    ...ids.map((id) => ctx.env.DB.prepare('INSERT INTO machine_owners (machine_id, user_id, assigned_at) VALUES (?, ?, ?)').bind(machine, id, now)),
    eventStmt(ctx, machine, null, 'OWNERS_SET', names.length ? names.join(', ') : 'nobody'),
    bumpStmt(ctx.env, 'machines'),
  ]);
  return json({ ok: true });
}

/** The machine's display name for alerts (its id when it has none). */
async function machineName(ctx: Ctx, id: string): Promise<string> {
  const row = await ctx.env.DB.prepare('SELECT name FROM machines WHERE id = ?').bind(id).first<{ name: string }>().catch(() => null);
  return row?.name || id;
}
