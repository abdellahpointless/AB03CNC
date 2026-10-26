import { HttpError, json, readJson } from '../http';
import { bumpStmt, newId, type Ctx } from '../context';
import { CALE_HEIGHTS } from '../../src/lib/cales';
import { requireMachine } from './fleet';
import { assertMayUpdate, clock } from './machines';

/*
 * The cales box of each machine. Users report pairs missing, damaged or found, confirm the whole box
 * once per shift, and ask for new cales; admins keep the spare stock (single cales) and approve the
 * requests. Every change goes into cales_events, kept forever and exported for ordering.
 */

function height(v: unknown): number {
  if (typeof v === 'number' && (CALE_HEIGHTS as readonly number[]).includes(v)) return v;
  throw new HttpError(400, 'Unknown cale height');
}

async function userMachine(ctx: Ctx): Promise<string> {
  const machine = (await requireMachine(ctx.env, ctx.params.machine)).id;
  await assertMayUpdate(ctx, machine);
  return machine;
}

// POST /api/machines/:machine/cales/report { height, kind: MISSING | DAMAGED | FOUND, count: 1 | 2 }
export async function handleCalesReport(ctx: Ctx): Promise<Response> {
  const machine = await userMachine(ctx);
  const body = await readJson<{ height?: unknown; kind?: unknown; count?: unknown }>(ctx.request, 2000);
  const h = height(body.height);
  const { now, shift } = clock(ctx);
  const db = ctx.env.DB;
  const user = ctx.user!.username;
  if (body.kind === 'FOUND') {
    // Only a missing pair can turn up again; a damaged one stays damaged until it is replaced.
    const [, removed] = await db.batch([
      db
        .prepare(
          `INSERT INTO cales_events (machine_id, height, kind, count, username, shift_key, at)
           SELECT machine_id, height, 'FOUND', count, ?, ?, ? FROM cales_state WHERE machine_id = ? AND height = ? AND status = 'MISSING'`,
        )
        .bind(user, shift.key, now, machine, h),
      db.prepare("DELETE FROM cales_state WHERE machine_id = ? AND height = ? AND status = 'MISSING'").bind(machine, h),
      bumpStmt(ctx.env, 'machines'),
    ]);
    if (!removed.meta.changes) throw new HttpError(409, 'This pair is not reported missing');
    return json({ ok: true });
  }
  if (body.kind !== 'MISSING' && body.kind !== 'DAMAGED') throw new HttpError(400, 'kind must be MISSING, DAMAGED or FOUND');
  if (body.count !== 1 && body.count !== 2) throw new HttpError(400, 'count must be 1 or 2');
  await db.batch([
    db
      .prepare(
        `INSERT INTO cales_state (machine_id, height, status, count, at, username) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (machine_id, height) DO UPDATE SET status = excluded.status, count = excluded.count, at = excluded.at, username = excluded.username`,
      )
      .bind(machine, h, body.kind, body.count, now, user),
    db
      .prepare('INSERT INTO cales_events (machine_id, height, kind, count, username, shift_key, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(machine, h, body.kind, body.count, user, shift.key, now),
    bumpStmt(ctx.env, 'machines'),
  ]);
  return json({ ok: true });
}

// POST /api/machines/:machine/cales/confirm -> "I found all the cales / all the rest", for this shift
export async function handleCalesConfirm(ctx: Ctx): Promise<Response> {
  const machine = await userMachine(ctx);
  const { now, shift } = clock(ctx);
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('INSERT OR IGNORE INTO cales_checks (machine_id, user_id, shift_key, username, at) VALUES (?, ?, ?, ?, ?)').bind(
      machine,
      ctx.user!.id,
      shift.key,
      ctx.user!.username,
      now,
    ),
    bumpStmt(ctx.env, 'machines'),
  ]);
  return json({ ok: true });
}

// POST /api/machines/:machine/cales/request { height } -> new cales for a missing or damaged pair
export async function handleCalesRequest(ctx: Ctx): Promise<Response> {
  const machine = await userMachine(ctx);
  const body = await readJson<{ height?: unknown }>(ctx.request, 1000);
  const h = height(body.height);
  const db = ctx.env.DB;
  const [made] = await db.batch([
    db
      .prepare(
        `INSERT INTO cales_requests (id, machine_id, height, kind, count, requested_by, at)
         SELECT ?, machine_id, height, status, count, ?, ? FROM cales_state s WHERE s.machine_id = ? AND s.height = ?
           AND NOT EXISTS (SELECT 1 FROM cales_requests r WHERE r.machine_id = s.machine_id AND r.height = s.height AND r.status = 'OPEN')`,
      )
      .bind(newId(), ctx.user!.username, Date.now(), machine, h),
    bumpStmt(ctx.env, 'machines'),
  ]);
  if (!made.meta.changes) throw new HttpError(409, 'New cales are already requested for this pair, or it is in its place');
  return json({ ok: true });
}

// Admin: GET /api/machines/cales/stock -> spare stock, open requests and the state of every box
export async function handleCalesStock(ctx: Ctx): Promise<Response> {
  const db = ctx.env.DB;
  const [stock, requests, state] = await db.batch([
    db.prepare('SELECT machine_id, height, qty FROM cales_stock'),
    db.prepare("SELECT id, machine_id, height, kind, count, requested_by, at FROM cales_requests WHERE status = 'OPEN' ORDER BY at"),
    db.prepare('SELECT machine_id, height, status, count FROM cales_state'),
  ]);
  return json({ stock: stock.results, requests: requests.results, state: state.results });
}

// Admin: PUT /api/machines/cales/stock/:machine/:height { qty } -> spare single cales on hand
export async function handleCalesSetStock(ctx: Ctx): Promise<Response> {
  const machine = (await requireMachine(ctx.env, ctx.params.machine)).id;
  const h = height(Number(ctx.params.height));
  const { qty } = await readJson<{ qty?: unknown }>(ctx.request, 1000);
  if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 0 || qty > 9999) throw new HttpError(400, 'Stock must be a whole number from 0 to 9999');
  await ctx.env.DB.prepare(
    `INSERT INTO cales_stock (machine_id, height, qty, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (machine_id, height) DO UPDATE SET qty = excluded.qty, updated_at = excluded.updated_at`,
  )
    .bind(machine, h, qty, Date.now())
    .run();
  return json({ ok: true });
}

// Admin: PUT /api/machines/cales/onmachine/:machine/:height { present: 0 | 1 | 2 }
// What is really in the machine's box (single cales of the pair). Below 2 the rest is missing: the
// box shows it and users can ask for new cales. 2 puts the pair back (a damaged pair: replaced).
export async function handleCalesSetOnMachine(ctx: Ctx): Promise<Response> {
  const machine = (await requireMachine(ctx.env, ctx.params.machine)).id;
  const h = height(Number(ctx.params.height));
  const { present } = await readJson<{ present?: unknown }>(ctx.request, 1000);
  if (present !== 0 && present !== 1 && present !== 2) throw new HttpError(400, 'present must be 0, 1 or 2');
  const { now, shift } = clock(ctx);
  const db = ctx.env.DB;
  const user = ctx.user!.username;
  const before = await db.prepare('SELECT status, count FROM cales_state WHERE machine_id = ? AND height = ?').bind(machine, h).first<{ status: string; count: number }>();
  const event = (kind: string, count: number) =>
    db.prepare('INSERT INTO cales_events (machine_id, height, kind, count, username, shift_key, at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(machine, h, kind, count, user, shift.key, now);
  const missing = 2 - present;
  if (missing === 0 ? !before : before?.status === 'MISSING' && before.count === missing) return json({ ok: true });
  await db.batch([
    missing === 0
      ? db.prepare('DELETE FROM cales_state WHERE machine_id = ? AND height = ?').bind(machine, h)
      : db
          .prepare(
            `INSERT INTO cales_state (machine_id, height, status, count, at, username) VALUES (?, ?, 'MISSING', ?, ?, ?)
             ON CONFLICT (machine_id, height) DO UPDATE SET status = 'MISSING', count = excluded.count, at = excluded.at, username = excluded.username`,
          )
          .bind(machine, h, missing, now, user),
    missing === 0 ? event(before!.status === 'MISSING' ? 'FOUND' : 'REPLACED', before!.count) : event('MISSING', missing),
    bumpStmt(ctx.env, 'machines'),
  ]);
  return json({ ok: true });
}

interface RequestRow {
  id: string;
  machine_id: string;
  height: number;
  count: number;
}

// Admin: POST /api/machines/cales/requests/:id { decision: APPROVE | REJECT }
export async function handleCalesDecide(ctx: Ctx): Promise<Response> {
  const { decision } = await readJson<{ decision?: unknown }>(ctx.request, 1000);
  if (decision !== 'APPROVE' && decision !== 'REJECT') throw new HttpError(400, 'decision must be APPROVE or REJECT');
  const db = ctx.env.DB;
  const req = await db.prepare("SELECT id, machine_id, height, count FROM cales_requests WHERE id = ? AND status = 'OPEN'").bind(ctx.params.id).first<RequestRow>();
  if (!req) throw new HttpError(409, 'This request was already decided');
  const { now, shift } = clock(ctx);
  const admin = ctx.user!.username;
  if (decision === 'REJECT') {
    const [r] = await db.batch([
      db.prepare("UPDATE cales_requests SET status = 'REJECTED', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'OPEN'").bind(admin, now, req.id),
      bumpStmt(ctx.env, 'machines'),
    ]);
    if (!r.meta.changes) throw new HttpError(409, 'This request was already decided');
    return json({ ok: true });
  }
  const stock = await db.prepare('SELECT qty FROM cales_stock WHERE machine_id = ? AND height = ?').bind(req.machine_id, req.height).first<{ qty: number }>();
  if (!stock || stock.qty < req.count) throw new HttpError(409, 'Out of stock');
  // One transaction, every step guarded: nothing happens if someone decided first or the pair turned
  // up again in the meantime, and the stock CHECK (qty >= 0) rolls everything back rather than go negative.
  const open = "EXISTS (SELECT 1 FROM cales_requests WHERE id = ? AND status = 'OPEN')";
  const out = 'EXISTS (SELECT 1 FROM cales_state WHERE machine_id = ? AND height = ?)';
  const m = req.machine_id;
  const h = req.height;
  const res = await db.batch([
    db.prepare(`UPDATE cales_stock SET qty = qty - ?, updated_at = ? WHERE machine_id = ? AND height = ? AND ${open} AND ${out}`).bind(req.count, now, m, h, req.id, m, h),
    db
      .prepare(`INSERT INTO cales_events (machine_id, height, kind, count, username, shift_key, at) SELECT ?, ?, 'REPLACED', ?, ?, ?, ? WHERE ${open} AND ${out}`)
      .bind(m, h, req.count, admin, shift.key, now, req.id, m, h),
    db.prepare(`UPDATE cales_requests SET status = 'APPROVED', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'OPEN' AND ${out}`).bind(admin, now, req.id, m, h),
    db
      .prepare("DELETE FROM cales_state WHERE machine_id = ? AND height = ? AND EXISTS (SELECT 1 FROM cales_requests WHERE id = ? AND status = 'APPROVED' AND decided_at = ?)")
      .bind(m, h, req.id, now),
    bumpStmt(ctx.env, 'machines'),
  ]);
  if (!res[2].meta.changes) throw new HttpError(409, 'This pair is back in its place, or the request was already decided');
  return json({ ok: true });
}

// Admin: GET /api/machines/cales/log?from=ms&to=ms -> every cales event of the period, for the order export
export async function handleCalesLog(ctx: Ctx): Promise<Response> {
  const from = Number(ctx.url.searchParams.get('from'));
  const to = Number(ctx.url.searchParams.get('to'));
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new HttpError(400, 'Choose a valid period');
  const { results } = await ctx.env.DB.prepare(
    'SELECT machine_id, height, kind, count, username, shift_key, at FROM cales_events WHERE at >= ? AND at < ? ORDER BY at LIMIT 20000',
  )
    .bind(from, to)
    .all();
  return json({ events: results });
}
