import { getHiddenUsers } from './analytics';
import { machineProblemAlert, missedTaskAlert, notifyLater, viseDamagedAlert } from '../alerts';
import { viseId } from '../../src/lib/cales';
import { HttpError, json, optStr, readJson, str } from '../http';
import { bumpStmt, newId, type Ctx } from '../context';
import { FREQUENCIES, type Frequency } from '../fleet';
import { requireMachine } from './fleet';
import { regionById } from '../../src/regions';
import { SHIFT_MS, currentPeriods, inEndWindow, periodKey, previousShift, shiftOf, shiftStart } from '../../src/lib/shifts';

/*
 * Preventive actions. Every user can mark a check as done, report a problem (on a check or on
 * the machine in general), say whether a problem stops the machine, and mark a problem as fixed.
 * Admins edit the checklists. Every action is written to machine_events so the history shows who
 * did what and when.
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
  stops: number;
}

/** "The machine is stopped by this problem": optional, true or false. */
function stopsFlag(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'boolean') return v;
  throw new HttpError(400, 'stops must be true or false');
}

async function machineParam(ctx: Ctx): Promise<string> {
  return (await requireMachine(ctx.env, ctx.params.machine)).id;
}

/**
 * A user who is responsible for one or more machines may only update those machines;
 * users with no machine assigned (and admins) may update every machine.
 */
export async function assertMayUpdate(ctx: Ctx, machine: string): Promise<void> {
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

/** Now, on this country's clock: the time zone and the running shift. */
export function clock(ctx: Ctx) {
  const tz = regionById(ctx.env.REGION)?.timeZone ?? 'UTC';
  const now = Date.now();
  return { now, tz, shift: shiftOf(now, tz) };
}

function frequency(v: unknown): Frequency {
  if (typeof v === 'string' && (FREQUENCIES as string[]).includes(v)) return v as Frequency;
  throw new HttpError(400, 'Frequency must be SHIFT_START, SHIFT_END, DAILY, WEEKLY, MONTHLY or QUARTERLY');
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

// GET /api/machines -> every check of every machine, the latest events, the cales boxes, and what
// the signed-in user already did in the current periods / shift
export async function handleListMachines(ctx: Ctx): Promise<Response> {
  const { now, tz, shift } = clock(ctx);
  const me = ctx.user!.id;
  const db = ctx.env.DB;
  const prev = previousShift(now, tz).key;
  const [checks, events, owners, mine, cales, calesChecked, calesRequests, prevDone, prevPeople] = await db.batch([
    ctx.env.DB.prepare('SELECT c.* FROM machine_checks c JOIN machines m ON m.id = c.machine_id AND m.active = 1 ORDER BY c.machine_id, c.sort, c.created_at'),
    ctx.env.DB.prepare('SELECT * FROM machine_events ORDER BY at DESC, id DESC LIMIT 300'),
    ctx.env.DB.prepare(
      `SELECT o.machine_id, o.user_id, u.username FROM machine_owners o JOIN users u ON u.id = o.user_id
       ORDER BY o.machine_id, u.username COLLATE NOCASE`,
    ),
    db.prepare('SELECT check_id FROM check_completions WHERE user_id = ? AND period_key IN (?, ?, ?, ?, ?)').bind(me, ...currentPeriods(now, tz)),
    db.prepare('SELECT machine_id, height, status, count FROM cales_state'),
    db.prepare('SELECT machine_id FROM cales_checks WHERE user_id = ? AND shift_key = ?').bind(me, shift.key),
    db.prepare("SELECT machine_id, height FROM cales_requests WHERE status = 'OPEN'"),
    // The previous shift: who confirmed its start / end tasks, and who worked on each machine then.
    db.prepare('SELECT check_id, username FROM check_completions WHERE period_key = ?').bind(prev),
    db.prepare('SELECT machine_id, username FROM check_completions WHERE shift_key = ?1 UNION SELECT machine_id, username FROM cales_checks WHERE shift_key = ?1').bind(prev),
  ]);
  // Same rule as assertMayUpdate: a non-admin responsible for machines is sent those machines only.
  const own = new Set((owners.results as { machine_id: string; user_id: string }[]).filter((o) => o.user_id === me).map((o) => o.machine_id));
  const only = <T extends { machine_id: string }>(rows: T[]) => (ctx.user!.role !== 'ADMIN' && own.size ? rows.filter((r) => own.has(r.machine_id)) : rows);
  return json({
    checks: only(checks.results as CheckRow[]),
    events: only(events.results as { machine_id: string }[]),
    owners: only(owners.results as { machine_id: string }[]),
    serverTime: now,
    shift,
    myDone: (mine.results as { check_id: string }[]).map((r) => r.check_id),
    cales: only(cales.results as { machine_id: string }[]),
    calesChecked: (calesChecked.results as { machine_id: string }[]).map((r) => r.machine_id),
    calesRequests: only(calesRequests.results as { machine_id: string }[]),
    prevShift: { key: prev, done: prevDone.results, people: only(prevPeople.results as { machine_id: string }[]) },
  });
}

// GET /api/machines/required -> what the signed-in user must still do before using the rest of the app:
// the due checks of the machines they look after (each person does them, once per period) and the
// cales box of those machines (once per shift). Admins and people with no machine are never asked.
// Workflow gate only: the app shows nothing but the checks while this list is not empty; the other
// API routes are deliberately not blocked (a lost connection must never stop the shop floor).
export async function handleRequired(ctx: Ctx): Promise<Response> {
  const user = ctx.user!;
  const { now, tz, shift } = clock(ctx);
  const endsAt = shiftStart(now, tz) + SHIFT_MS;
  if (user.role === 'ADMIN') return json({ locked: false, items: [], ending: [], shift, endsAt });
  const db = ctx.env.DB;
  const [day, week, month, quarter, shiftKey] = currentPeriods(now, tz);
  const [checks, cales] = await db.batch([
    // An open problem on a check is already reported: it does not keep anyone locked out.
    db
      .prepare(
        `SELECT c.id, c.machine_id, c.title, c.frequency FROM machine_checks c
         JOIN machine_owners o ON o.machine_id = c.machine_id AND o.user_id = ?1
         JOIN machines m ON m.id = c.machine_id AND m.active = 1
         WHERE c.kind = 'CHECK' AND c.frequency IS NOT NULL AND c.status = 'OK'
           AND NOT EXISTS (SELECT 1 FROM check_completions x WHERE x.check_id = c.id AND x.user_id = ?1 AND x.period_key =
             CASE c.frequency WHEN 'DAILY' THEN ?2 WHEN 'WEEKLY' THEN ?3 WHEN 'MONTHLY' THEN ?4 WHEN 'QUARTERLY' THEN ?5 ELSE ?6 END)
         ORDER BY c.machine_id, c.sort`,
      )
      .bind(user.id, day, week, month, quarter, shiftKey),
    db
      .prepare(
        `SELECT o.machine_id FROM machine_owners o JOIN machines m ON m.id = o.machine_id AND m.active = 1
         WHERE o.user_id = ?1 AND NOT EXISTS (SELECT 1 FROM cales_checks k WHERE k.machine_id = o.machine_id AND k.user_id = ?1 AND k.shift_key = ?2)
         ORDER BY o.machine_id`,
      )
      .bind(user.id, shift.key),
  ]);
  const rows = checks.results as { id: string; machine_id: string; title: string; frequency: Frequency }[];
  const item = (c: (typeof rows)[number]) => ({ kind: 'CHECK' as const, machineId: c.machine_id, id: c.id, title: c.title });
  const items = [
    ...rows.filter((c) => c.frequency !== 'SHIFT_END').map(item),
    ...(cales.results as { machine_id: string }[]).map((r) => ({ kind: 'CALES' as const, machineId: r.machine_id })),
  ];
  // End-of-shift tasks never lock anyone out: in the last 45 minutes the app rings for them instead.
  const ending = inEndWindow(now, tz) ? rows.filter((c) => c.frequency === 'SHIFT_END').map(item) : [];
  return json({ locked: items.length > 0, items, ending, shift, endsAt });
}

// POST /api/machines/:machine/checks/:id/missed -> a start / end of shift task was not done in the
// previous shift. The server names the people: whoever confirmed it then (so it was not really done),
// otherwise whoever worked on this machine during that shift. Once per task per shift.
export async function handleReportMissed(ctx: Ctx): Promise<Response> {
  const machine = await machineParam(ctx);
  await assertMayUpdate(ctx, machine);
  const check = await loadCheck(ctx, machine);
  if (check.frequency !== 'SHIFT_START' && check.frequency !== 'SHIFT_END') throw new HttpError(400, 'Only start and end of shift tasks can be reported for the previous shift');
  const { now, tz } = clock(ctx);
  const prev = previousShift(now, tz).key;
  const db = ctx.env.DB;
  const [confirmed, present] = await db.batch([
    db.prepare('SELECT username FROM check_completions WHERE check_id = ? AND period_key = ?').bind(check.id, prev),
    db.prepare('SELECT username FROM check_completions WHERE machine_id = ?1 AND shift_key = ?2 UNION SELECT username FROM cales_checks WHERE machine_id = ?1 AND shift_key = ?2').bind(machine, prev),
  ]);
  const names = [...new Set((confirmed.results.length ? confirmed.results : present.results).map((r) => (r as { username: string }).username))];
  if (!names.length) throw new HttpError(409, 'Nobody worked on this machine in the previous shift');
  const [made] = await db.batch([
    db
      .prepare(
        `INSERT INTO machine_events (machine_id, check_id, check_title, action, note, username, at)
         SELECT ?, ?, ?, 'MISSED', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM machine_events WHERE check_id = ? AND action = 'MISSED' AND at >= ?)`,
      )
      .bind(machine, check.id, check.title, names.join(', '), ctx.user!.username, now, check.id, shiftStart(now, tz)),
    bumpStmt(ctx.env, 'machines'),
  ]);
  if (!made.meta.changes) throw new HttpError(409, 'This task was already reported for the previous shift');
  const a = missedTaskAlert(ctx.env.REGION, await machineName(ctx, machine), check.title, names.join(', '), ctx.user!.username);
  await notifyLater(ctx, 'missedTask', a.message, a.call, `${machine}:${check.id}:missed`);
  return json({ ok: true, users: names });
}

// POST /api/machines/:machine/checks/:id/action
//   { action: DONE | PROBLEM | RESOLVE, note?, stops? }  stops: the problem stops the machine
//   { action: STOPS, stops }                             an open problem stops it (or no longer)
export async function handleCheckAction(ctx: Ctx): Promise<Response> {
  const machine = await machineParam(ctx);
  await assertMayUpdate(ctx, machine);
  const check = await loadCheck(ctx, machine);
  const body = await readJson<{ action?: unknown; note?: unknown; stops?: unknown }>(ctx.request, 5000);
  const { now, tz, shift } = clock(ctx);
  const user = ctx.user!.username;
  const db = ctx.env.DB;
  let note: string | null = null;
  let event = body.action as string;
  const stmts: D1PreparedStatement[] = [];
  const after: D1PreparedStatement[] = [];
  const stops = stopsFlag(body.stops);
  // Every person's own answer for this period (a problem counts as done).
  const completion = (result: 'OK' | 'PROBLEM') =>
    check.kind === 'CHECK' && check.frequency
      ? [
          db
            .prepare(
              `INSERT INTO check_completions (check_id, machine_id, user_id, username, period_key, result, shift_key, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (check_id, user_id, period_key) DO UPDATE SET result = excluded.result, shift_key = excluded.shift_key, at = excluded.at`,
            )
            .bind(check.id, machine, ctx.user!.id, user, periodKey(check.frequency, now, tz), result, shift.key, now),
        ]
      : [];

  switch (body.action) {
    case 'DONE':
      if (check.kind !== 'CHECK') throw new HttpError(400, 'Only checklist items can be marked as done');
      note = optStr(body.note, 'Note', 300);
      stmts.push(db.prepare('UPDATE machine_checks SET last_done_at = ?, last_done_by = ? WHERE id = ?').bind(now, user, check.id), ...completion('OK'));
      break;
    case 'PROBLEM':
      note = str(body.note, 'Problem description', { min: 3, max: 300 });
      stmts.push(
        db
          .prepare("UPDATE machine_checks SET status = 'PROBLEM', note = ?, status_at = ?, status_by = ?, stops = ? WHERE id = ?")
          .bind(note, now, user, stops ? 1 : 0, check.id),
        ...completion('PROBLEM'),
      );
      if (stops) after.push(eventStmt(ctx, machine, check, 'MACHINE_DOWN', note));
      break;
    case 'STOPS':
      if (check.status !== 'PROBLEM') throw new HttpError(400, 'Only an open problem can stop the machine');
      if (typeof body.stops !== 'boolean') throw new HttpError(400, 'stops must be true or false');
      if (!!check.stops === stops) return json({ ok: true });
      note = check.kind === 'ISSUE' ? check.note : check.note || check.title;
      event = stops ? 'MACHINE_DOWN' : 'MACHINE_UP';
      stmts.push(db.prepare('UPDATE machine_checks SET stops = ? WHERE id = ?').bind(stops ? 1 : 0, check.id));
      break;
    case 'RESOLVE':
      note = optStr(body.note, 'Note', 300);
      stmts.push(
        check.kind === 'ISSUE'
          ? db.prepare('DELETE FROM machine_checks WHERE id = ?').bind(check.id)
          : db.prepare("UPDATE machine_checks SET status = 'OK', note = NULL, status_at = ?, status_by = ?, stops = 0 WHERE id = ?").bind(now, user, check.id),
      );
      break;
    default:
      throw new HttpError(400, 'Action must be DONE, PROBLEM, STOPS or RESOLVE');
  }
  stmts.push(eventStmt(ctx, machine, check, event, note), ...after, bumpStmt(ctx.env, 'machines'));
  await db.batch(stmts);
  if (body.action === 'PROBLEM' || (body.action === 'STOPS' && stops)) {
    const what = check.kind === 'ISSUE' ? check.note || check.title : `${check.title}${note && note !== check.title ? ` — ${note}` : ''}`;
    const a = machineProblemAlert(ctx.env.REGION, await machineName(ctx, machine), what, user, stops);
    // "stops" is part of the key: a problem that then turns out to stop the machine must still be sent.
    await notifyLater(ctx, 'machineProblem', a.message, a.call, `${machine}:${check.id}:${stops}`);
  }
  return json({ ok: true });
}

// POST /api/machines/:machine/issues { note, stops? } -> a problem with the machine that isn't on
// the checklist (stops: the machine cannot run)
export async function handleReportIssue(ctx: Ctx): Promise<Response> {
  const machine = await machineParam(ctx);
  await assertMayUpdate(ctx, machine);
  const body = await readJson<{ note?: unknown; stops?: unknown }>(ctx.request, 5000);
  const note = str(body.note, 'Problem description', { min: 3, max: 300 });
  const stops = stopsFlag(body.stops);
  const id = newId();
  const now = Date.now();
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `INSERT INTO machine_checks (id, machine_id, kind, title, frequency, status, note, status_at, status_by, sort, created_at, stops)
       VALUES (?, ?, 'ISSUE', ?, NULL, 'PROBLEM', ?, ?, ?, 0, ?, ?)`,
    ).bind(id, machine, note, note, now, ctx.user!.username, now, stops ? 1 : 0),
    eventStmt(ctx, machine, { id, title: note }, 'PROBLEM', note),
    ...(stops ? [eventStmt(ctx, machine, { id, title: note }, 'MACHINE_DOWN', note)] : []),
    bumpStmt(ctx.env, 'machines'),
  ]);
  const a = machineProblemAlert(ctx.env.REGION, await machineName(ctx, machine), note, ctx.user!.username, stops);
  await notifyLater(ctx, 'machineProblem', a.message, a.call, `${machine}:${id}`);
  return json({ ok: true, id });
}

// POST /api/machines/:machine/vise { note? } -> the machine's vise is damaged (see viseId)
export async function handleReportVise(ctx: Ctx): Promise<Response> {
  const machine = await machineParam(ctx);
  await assertMayUpdate(ctx, machine);
  const body = await readJson<{ note?: unknown }>(ctx.request, 2000);
  const extra = optStr(body.note, 'Note', 300);
  const id = viseId(machine);
  const db = ctx.env.DB;
  if (await db.prepare('SELECT 1 FROM machine_checks WHERE id = ?').bind(id).first()) throw new HttpError(409, 'The vise is already reported damaged');
  // Stored in the country's language, like everything people type there.
  const title = regionById(ctx.env.REGION)?.language === 'tr' ? 'Mengene hasarlı' : 'Vise damaged';
  const note = extra ? `${title}: ${extra}` : title;
  const now = Date.now();
  const user = ctx.user!.username;
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO machine_checks (id, machine_id, kind, title, frequency, status, note, status_at, status_by, sort, created_at, stops)
         VALUES (?, ?, 'ISSUE', ?, NULL, 'PROBLEM', ?, ?, ?, 0, ?, 0)`,
      )
      .bind(id, machine, title, note, now, user, now),
    eventStmt(ctx, machine, { id, title }, 'PROBLEM', note),
    bumpStmt(ctx.env, 'machines'),
  ]);
  const a = viseDamagedAlert(ctx.env.REGION, await machineName(ctx, machine), extra, user);
  await notifyLater(ctx, 'machineProblem', a.message, a.call, `${machine}:vise`);
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

const REPORT_LIMIT = 2000;

// Admin: GET /api/machines/report?from=&to=  (ms, end excluded; at most ~13 months)
// What went wrong in the period (problems, stopped machines, "not done" reports, missing or damaged
// cales) and, per person, how many checks they confirmed. Hidden test accounts are left out.
export async function handleMachinesReport(ctx: Ctx): Promise<Response> {
  const from = Number(ctx.url.searchParams.get('from'));
  const to = Number(ctx.url.searchParams.get('to'));
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > 400 * 86_400_000) throw new HttpError(400, 'Invalid date range');
  const db = ctx.env.DB;
  const [events, cales, people, hidden, perMachine, taken] = await Promise.all([
    db
      .prepare(
        `SELECT machine_id, check_title, action, note, username, at FROM machine_events
         WHERE action IN ('PROBLEM', 'MACHINE_DOWN', 'MISSED') AND at >= ? AND at < ? ORDER BY at DESC LIMIT ${REPORT_LIMIT + 1}`,
      )
      .bind(from, to)
      .all<{ machine_id: string; check_title: string | null; action: string; note: string | null; username: string; at: number }>(),
    db
      .prepare(
        `SELECT machine_id, height, kind, count, username, at FROM cales_events
         WHERE kind IN ('MISSING', 'DAMAGED') AND at >= ? AND at < ? ORDER BY at DESC LIMIT ${REPORT_LIMIT + 1}`,
      )
      .bind(from, to)
      .all<{ machine_id: string; height: number; kind: string; count: number; username: string; at: number }>(),
    db
      .prepare(
        `SELECT username, SUM(ok) AS done, SUM(bad) AS problems FROM (
           SELECT username, result = 'OK' AS ok, result = 'PROBLEM' AS bad FROM check_completions WHERE at >= ?1 AND at < ?2
           UNION ALL SELECT username, 1, 0 FROM cales_checks WHERE at >= ?1 AND at < ?2
         ) GROUP BY username COLLATE NOCASE ORDER BY done DESC`,
      )
      .bind(from, to)
      .all<{ username: string; done: number; problems: number }>(),
    getHiddenUsers(ctx.env),
    // Per machine and person (hidden accounts are left out below): checks and cales boxes confirmed.
    db
      .prepare(
        `SELECT machine_id, username, SUM(c) AS checks, SUM(p) AS problems, SUM(k) AS cales FROM (
           SELECT machine_id, username, 1 AS c, result = 'PROBLEM' AS p, 0 AS k FROM check_completions WHERE at >= ?1 AND at < ?2
           UNION ALL SELECT machine_id, username, 0, 0, 1 FROM cales_checks WHERE at >= ?1 AND at < ?2
         ) GROUP BY machine_id, username COLLATE NOCASE`,
      )
      .bind(from, to)
      .all<{ machine_id: string; username: string; checks: number; problems: number; cales: number }>(),
    // Cales the machines took from the general stock (approved requests).
    db
      .prepare(
        `SELECT machine_id, height, count, requested_by, decided_by, decided_at AS at FROM cales_requests
         WHERE status = 'APPROVED' AND decided_at >= ? AND decided_at < ? ORDER BY decided_at LIMIT ${REPORT_LIMIT}`,
      )
      .bind(from, to)
      .all<{ machine_id: string; height: number; count: number; requested_by: string; decided_by: string; at: number }>(),
  ]);
  const shown = (u: string) => !hidden.includes(u.toLowerCase());
  const machines = new Map<string, { machine_id: string; checks: number; problems: number; cales: number }>();
  for (const r of perMachine.results) {
    if (!shown(r.username)) continue;
    const m = machines.get(r.machine_id) ?? { machine_id: r.machine_id, checks: 0, problems: 0, cales: 0 };
    m.checks += r.checks;
    m.problems += r.problems;
    m.cales += r.cales;
    machines.set(r.machine_id, m);
  }
  return json({
    events: events.results.slice(0, REPORT_LIMIT),
    cales: cales.results.slice(0, REPORT_LIMIT),
    // The list is the newest rows only; the screen says so instead of looking complete.
    truncated: events.results.length > REPORT_LIMIT || cales.results.length > REPORT_LIMIT,
    people: people.results.filter((p) => shown(p.username)),
    machines: [...machines.values()],
    taken: taken.results,
    hidden,
  });
}
