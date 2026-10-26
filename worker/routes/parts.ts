import { HttpError, intParam, json, readJson, str } from '../http';
import { bumpStmt, type Ctx } from '../context';

const PAGE_SIZE = 25;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function validateSap(raw: unknown): string {
  const s = str(raw, 'SAP number', { min: 1, max: 40 }).toUpperCase();
  if (!/^[A-Z0-9\-_.]+$/.test(s)) {
    throw new HttpError(400, 'SAP number can only contain letters, numbers, hyphens (-), underscores (_), and periods (.).');
  }
  return s;
}

function monthIndex(key: string): number {
  const [y, m] = key.split('-').map(Number);
  return y * 12 + (m - 1);
}

/** The PC's local month is used (so entries land in the operator's calendar month), but must be plausible. */
function validateMonthKey(raw: unknown): string {
  const now = new Date();
  const serverKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  if (typeof raw !== 'string' || !MONTH_RE.test(raw)) return serverKey;
  return Math.abs(monthIndex(raw) - monthIndex(serverKey)) <= 1 ? raw : serverKey;
}

/** Optional ?from=&to= (ms, end excluded): a period such as the 26th to the 26th, on the entry time. */
function rangeOf(url: URL): { sql: string; args: string[] } | null {
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!from && !to) return null;
  const f = Number(from);
  const t = Number(to);
  if (!Number.isFinite(f) || !Number.isFinite(t) || f >= t || t - f > 400 * 86_400_000) throw new HttpError(400, 'Invalid date range');
  // julianday() reads every date format the Excel import may have stored, not only toISOString().
  return { sql: 'julianday(created_at) >= julianday(?) AND julianday(created_at) < julianday(?)', args: [new Date(f).toISOString(), new Date(t).toISOString()] };
}

const summarySql = (where: string) => `
  SELECT month_key, user_id, MAX(username) AS username, SUM(qty) AS total_qty, SUM(qty * unit_value) AS total_value
  FROM part_entries WHERE status = 'APPROVED' ${where}
  GROUP BY month_key, user_id ORDER BY month_key DESC, username COLLATE NOCASE`;

// POST /api/parts { id?, sapNumber, qty, kind, monthKey }
export async function handleSubmitPart(ctx: Ctx): Promise<Response> {
  const user = ctx.user!;
  const body = await readJson<any>(ctx.request, 5000);
  const sap = validateSap(body.sapNumber);
  const qty = Number(body.qty);
  if (!Number.isInteger(qty) || qty < 1 || qty > 9999) throw new HttpError(400, 'Quantity must be between 1 and 9999.');
  const kind = body.kind === 'MODIFICATION' ? 'MODIFICATION' : body.kind === 'PRODUCED' ? 'PRODUCED' : null;
  if (!kind) throw new HttpError(400, 'Kind must be PRODUCED or MODIFICATION');
  const id = typeof body.id === 'string' && /^[0-9a-f-]{36}$/i.test(body.id) ? body.id : crypto.randomUUID();
  const entry = {
    id,
    user_id: user.id,
    username: user.username,
    sap_number: sap,
    qty,
    kind,
    unit_value: kind === 'PRODUCED' ? 1 : 0.5,
    status: 'PENDING',
    month_key: validateMonthKey(body.monthKey),
    created_at: new Date().toISOString(),
  };
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `INSERT OR IGNORE INTO part_entries (id, user_id, username, sap_number, qty, kind, unit_value, status, month_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
    ).bind(entry.id, entry.user_id, entry.username, entry.sap_number, entry.qty, entry.kind, entry.unit_value, entry.month_key, entry.created_at),
    bumpStmt(ctx.env, 'parts'),
  ]);
  return json({ ok: true, entry });
}

// GET /api/parts/summary  -> my approved totals per month
export async function handleMySummary(ctx: Ctx): Promise<Response> {
  const { results } = await ctx.env.DB.prepare(summarySql('AND user_id = ?')).bind(ctx.user!.id).all();
  return json({ rows: results });
}

// GET /api/parts/month/:month?page=  -> my approved entries for a month (no review details)
export async function handleMyMonthEntries(ctx: Ctx): Promise<Response> {
  const month = ctx.params.month;
  if (!MONTH_RE.test(month)) throw new HttpError(400, 'Invalid month');
  const page = intParam(ctx.url, 'page', 0, 0, 10_000);
  const { results } = await ctx.env.DB.prepare(
    `SELECT id, sap_number, qty, kind, unit_value, created_at FROM part_entries
     WHERE user_id = ? AND status = 'APPROVED' AND month_key = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(ctx.user!.id, month, PAGE_SIZE + 1, page * PAGE_SIZE)
    .all();
  return json({ entries: results.slice(0, PAGE_SIZE), hasMore: results.length > PAGE_SIZE });
}

// GET /api/parts/export?offset=  -> my approved entries for the Excel export
export async function handleMyExport(ctx: Ctx): Promise<Response> {
  const offset = intParam(ctx.url, 'offset', 0, 0, 10_000_000);
  const { results } = await ctx.env.DB.prepare(
    `SELECT created_at, sap_number, qty, kind, unit_value, month_key FROM part_entries
     WHERE user_id = ? AND status = 'APPROVED' ORDER BY created_at DESC LIMIT 500 OFFSET ?`,
  )
    .bind(ctx.user!.id, offset)
    .all();
  return json({ entries: results, hasMore: results.length === 500 });
}

// GET /api/parts/pending?page=  (admin)
export async function handlePending(ctx: Ctx): Promise<Response> {
  const page = intParam(ctx.url, 'page', 0, 0, 10_000);
  const { results } = await ctx.env.DB.prepare(
    `SELECT id, user_id, username, sap_number, qty, kind, unit_value, status, month_key, created_at, reviewed_at, reviewed_by
     FROM part_entries WHERE status = 'PENDING' ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(PAGE_SIZE + 1, page * PAGE_SIZE)
    .all();
  return json({ entries: results.slice(0, PAGE_SIZE), hasMore: results.length > PAGE_SIZE });
}

// POST /api/parts/review { ids: string[], status: 'APPROVED' | 'REJECTED' }  (admin)
export async function handleReview(ctx: Ctx): Promise<Response> {
  const body = await readJson<{ ids?: unknown; status?: unknown }>(ctx.request, 20_000);
  const status = body.status === 'APPROVED' || body.status === 'REJECTED' ? body.status : null;
  if (!status) throw new HttpError(400, 'status must be APPROVED or REJECTED');
  if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 200 || !body.ids.every((i) => typeof i === 'string')) {
    throw new HttpError(400, 'ids must be a list of entry ids (max 200)');
  }
  const [res] = await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `UPDATE part_entries SET status = ?, reviewed_at = ?, reviewed_by = ?
       WHERE status = 'PENDING' AND id IN (SELECT value FROM json_each(?))`,
    ).bind(status, new Date().toISOString(), ctx.user!.username, JSON.stringify(body.ids)),
    bumpStmt(ctx.env, 'parts'),
  ]);
  return json({ ok: true, updated: res.meta.changes ?? 0 });
}

// GET /api/parts/admin-summary?month=  (admin)
export async function handleAdminSummary(ctx: Ctx): Promise<Response> {
  const month = ctx.url.searchParams.get('month') || '';
  if (month && !MONTH_RE.test(month)) throw new HttpError(400, 'Month filter must look like YYYY-MM');
  const range = rangeOf(ctx.url);
  const stmt = range
    ? ctx.env.DB.prepare(summarySql(`AND ${range.sql}`)).bind(...range.args)
    : month
      ? ctx.env.DB.prepare(summarySql('AND month_key = ?')).bind(month)
      : ctx.env.DB.prepare(summarySql(''));
  const { results } = await stmt.all();
  return json({ rows: results });
}

// GET /api/parts/admin-production?month=YYYY-MM or ?from=&to=  (admin)
// One month at a glance, per operator: approved produced / modified quantities and value,
// plus what is still waiting for review. (The Excel export is unchanged.)
export async function handleAdminProduction(ctx: Ctx): Promise<Response> {
  const month = ctx.url.searchParams.get('month') || '';
  const range = rangeOf(ctx.url);
  if (!range && !MONTH_RE.test(month)) throw new HttpError(400, 'Month filter must look like YYYY-MM');
  const { results } = await ctx.env.DB.prepare(
    `SELECT user_id, MAX(username) AS username,
       SUM(CASE WHEN status = 'APPROVED' AND kind = 'PRODUCED' THEN qty ELSE 0 END) AS produced_qty,
       SUM(CASE WHEN status = 'APPROVED' AND kind = 'MODIFICATION' THEN qty ELSE 0 END) AS modification_qty,
       SUM(CASE WHEN status = 'APPROVED' THEN qty * unit_value ELSE 0 END) AS total_value,
       SUM(CASE WHEN status = 'PENDING' THEN qty ELSE 0 END) AS pending_qty
     FROM part_entries
     WHERE ${range ? range.sql : 'month_key = ?'} AND status IN ('APPROVED', 'PENDING')
     GROUP BY user_id
     ORDER BY total_value DESC, username COLLATE NOCASE`,
  )
    .bind(...(range ? range.args : [month]))
    .all();
  return json({ month, rows: results });
}

// GET /api/parts/admin-export?month=&offset= or ?from=&to=&offset=  (admin, includes review columns)
export async function handleAdminExport(ctx: Ctx): Promise<Response> {
  const month = ctx.url.searchParams.get('month') || '';
  if (month && !MONTH_RE.test(month)) throw new HttpError(400, 'Month filter must look like YYYY-MM');
  const offset = intParam(ctx.url, 'offset', 0, 0, 10_000_000);
  const cols = 'id, user_id, created_at, username, sap_number, qty, kind, unit_value, status, reviewed_at, reviewed_by, month_key';
  const range = rangeOf(ctx.url);
  const stmt = range
    ? ctx.env.DB.prepare(`SELECT ${cols} FROM part_entries WHERE ${range.sql} ORDER BY created_at DESC LIMIT 500 OFFSET ?`).bind(...range.args, offset)
    : month
    ? ctx.env.DB.prepare(`SELECT ${cols} FROM part_entries WHERE month_key = ? ORDER BY created_at DESC LIMIT 500 OFFSET ?`).bind(month, offset)
    : ctx.env.DB.prepare(`SELECT ${cols} FROM part_entries ORDER BY created_at DESC LIMIT 500 OFFSET ?`).bind(offset);
  const { results } = await stmt.all();
  return json({ entries: results, hasMore: results.length === 500 });
}
