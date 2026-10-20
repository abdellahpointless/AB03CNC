import { HttpError, intParam, json, num, optStr, readJson, str } from '../http';
import { bumpStmt, type Ctx, type Env } from '../context';
import { consumeQuota } from '../security';

// Stay well under D1's 2 MB per-value limit.
const CODE_CHUNK_CHARS = 900_000;
// Imports (admin) may carry big old files; a program saved from the app is far smaller
// (the largest so far is ~330 KB before compression).
const MAX_IMPORT_CODE_CHARS = 40_000_000;
const MAX_UPLOAD_CODE_CHARS = 8_000_000;
const MAX_CHANGES = 300;
const HISTORY_PER_DAY = 500;
const SEARCHES_PER_HOUR = 600;

interface HistoryRow {
  id: string;
  created_at: number;
  date_label: string;
  username: string;
  machine: string | null;
  original_file_name: string;
  exported_file_name: string;
  changes: string;
  has_code: number;
}

const HISTORY_COLUMNS =
  'id, created_at, date_label, username, machine, original_file_name, exported_file_name, changes, has_code';

export function rowToRecord(r: HistoryRow) {
  let changes: unknown[] = [];
  try {
    const parsed = JSON.parse(r.changes);
    if (Array.isArray(parsed)) changes = parsed;
  } catch {
    /* keep empty */
  }
  return {
    id: r.id,
    date: r.date_label,
    isoDate: new Date(r.created_at).toISOString(),
    timestamp: r.created_at,
    user: r.username,
    machine: r.machine ?? undefined,
    originalFileName: r.original_file_name,
    exportedFileName: r.exported_file_name,
    changes,
    hasCode: !!r.has_code,
  };
}

export interface NormalizedHistory {
  id: string;
  createdAt: number;
  dateLabel: string;
  username: string;
  machine: string | null;
  originalFileName: string;
  exportedFileName: string;
  changes: any[];
  appChosen: number;
  manualChosen: number;
}

/** Normalises a history record (from the UI or from old exported data). */
export function normalizeHistory(raw: any, fallbackUser: string, strict: boolean): NormalizedHistory | null {
  try {
    if (!raw || typeof raw !== 'object') throw new HttpError(400, 'record required');
    const id = str(raw.id, 'id', { min: 1, max: 64 });
    let createdAt = Number(raw.timestamp ?? raw.createdAt);
    if (!Number.isFinite(createdAt) || createdAt <= 0) {
      const fromIso = raw.isoDate ? Date.parse(raw.isoDate) : NaN;
      const fromLabel = raw.date ? Date.parse(raw.date) : NaN;
      createdAt = Number.isFinite(fromIso) ? fromIso : Number.isFinite(fromLabel) ? fromLabel : Date.now();
    }
    if (createdAt > Date.now() + 86_400_000) createdAt = Date.now();
    // Records saved from the app are recent (the offline queue holds them a few days at most).
    if (strict && createdAt < Date.now() - 14 * 86_400_000) createdAt = Date.now();
    if (strict && Array.isArray(raw.changes) && raw.changes.length > MAX_CHANGES) {
      throw new HttpError(400, `A program can record at most ${MAX_CHANGES} tool changes`);
    }
    const changesRaw = Array.isArray(raw.changes) ? raw.changes.slice(0, 1000) : [];
    const changes = changesRaw
      .filter((c: any) => c && typeof c === 'object')
      .map((c: any) => ({
        originalT: String(c.originalT ?? 'M6').slice(0, 40),
        originalContext: String(c.originalContext ?? '').slice(0, strict ? 300 : 1000),
        reqDiameter: c.reqDiameter === null || c.reqDiameter === undefined ? null : Number(c.reqDiameter) || 0,
        reqLength: c.reqLength === null || c.reqLength === undefined ? null : Number(c.reqLength) || 0,
        appChose: !!c.appChose,
        chosenCategory: String(c.chosenCategory ?? 'unknown').slice(0, 40),
        chosenT: Number(c.chosenT) || 0,
        chosenDiameter: Number(c.chosenDiameter) || 0,
        chosenLength: Number(c.chosenLength) || 0,
      }));
    const appChosen = changes.filter((c: any) => c.appChose).length;
    return {
      id,
      createdAt,
      dateLabel: String(raw.date || raw.dateLabel || new Date(createdAt).toLocaleString('en-GB')).slice(0, 80),
      username: String(raw.user || fallbackUser || 'Unknown').slice(0, 60),
      machine: optStr(raw.machine, 'machine', 40),
      originalFileName: String(raw.originalFileName || 'program.nc').slice(0, 255),
      exportedFileName: String(raw.exportedFileName || raw.originalFileName || 'program.text').slice(0, 255),
      changes,
      appChosen,
      manualChosen: changes.length - appChosen,
    };
  } catch (e) {
    if (strict) throw e;
    return null;
  }
}

export interface CodePayload {
  encoding: 'gzip-base64' | 'plain';
  data: string;
  size: number;
}

export function parseCode(raw: any, maxChars = MAX_IMPORT_CODE_CHARS): CodePayload | null {
  if (!raw) return null;
  const encoding = raw.encoding === 'plain' ? 'plain' : raw.encoding === 'gzip-base64' ? 'gzip-base64' : null;
  if (!encoding) throw new HttpError(400, 'Unsupported code encoding');
  const data = typeof raw.data === 'string' ? raw.data : '';
  if (!data) return null;
  if (data.length > maxChars) throw new HttpError(413, 'Program file is too large to store');
  return { encoding, data, size: num(raw.size ?? data.length, 'size', { min: 0, max: 1e9, integer: true }) };
}

export function codeStatements(env: Env, fileId: string, code: CodePayload, createdAt: number): D1PreparedStatement[] {
  const chunks: string[] = [];
  for (let i = 0; i < code.data.length; i += CODE_CHUNK_CHARS) chunks.push(code.data.slice(i, i + CODE_CHUNK_CHARS));
  return [
    env.DB.prepare('DELETE FROM code_chunks WHERE file_id = ?').bind(fileId),
    env.DB.prepare(
      'INSERT OR REPLACE INTO code_files (id, encoding, size, chunks, created_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(fileId, code.encoding, code.size, chunks.length, createdAt),
    ...chunks.map((c, seq) => env.DB.prepare('INSERT INTO code_chunks (file_id, seq, data) VALUES (?, ?, ?)').bind(fileId, seq, c)),
  ];
}

/** Statements that insert a history record and update the running statistics. */
export function historyInsertStatements(env: Env, h: NormalizedHistory, hasCode: boolean): D1PreparedStatement[] {
  return [
    env.DB.prepare(
      `INSERT INTO history (id, created_at, date_label, username, machine, original_file_name, exported_file_name, changes, app_chosen, manual_chosen, has_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      h.id,
      h.createdAt,
      h.dateLabel,
      h.username,
      h.machine,
      h.originalFileName,
      h.exportedFileName,
      JSON.stringify(h.changes),
      h.appChosen,
      h.manualChosen,
      hasCode ? 1 : 0,
    ),
    env.DB.prepare(
      `INSERT INTO extraction_stats (username, extractions, last_at) VALUES (?, 1, ?)
       ON CONFLICT(username) DO UPDATE SET extractions = extractions + 1, last_at = MAX(COALESCE(last_at, 0), excluded.last_at)`,
    ).bind(h.username, h.createdAt),
    env.DB.prepare(
      `UPDATE counters SET value = value + CASE name
         WHEN 'history_total' THEN 1 WHEN 'tools_app_selected' THEN ?1 WHEN 'tools_manual' THEN ?2 END
       WHERE name IN ('history_total', 'tools_app_selected', 'tools_manual')`,
    ).bind(h.appChosen, h.manualChosen),
  ];
}

// POST /api/history  { record, code? }
export async function handleCreateHistory(ctx: Ctx): Promise<Response> {
  const body = await readJson<{ record?: unknown; code?: unknown }>(ctx.request, 10 * 1024 * 1024);
  // The operator is always the signed-in user, never what the client claims.
  const h = normalizeHistory({ ...(body.record as object), user: ctx.user!.username }, ctx.user!.username, true)!;
  const code = parseCode(body.code, MAX_UPLOAD_CODE_CHARS);

  const exists = await ctx.env.DB.prepare('SELECT 1 AS x FROM history WHERE id = ?').bind(h.id).first();
  if (exists) return json({ ok: true, duplicate: true }); // safe retry from the offline queue
  await consumeQuota(ctx.env, `hist:${ctx.user!.id}`, HISTORY_PER_DAY, 86_400_000, 'Daily upload limit reached. Try again tomorrow.');

  await ctx.env.DB.batch([
    ...historyInsertStatements(ctx.env, h, !!code),
    ...(code ? codeStatements(ctx.env, h.id, code, h.createdAt) : []),
    bumpStmt(ctx.env, 'history'),
  ]);
  return json({ ok: true });
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

// GET /api/history?limit=&offset=&user=&q=
export async function handleListHistory(ctx: Ctx): Promise<Response> {
  const limit = intParam(ctx.url, 'limit', 10, 1, 100);
  const offset = intParam(ctx.url, 'offset', 0, 0, 10_000);
  const user = ctx.url.searchParams.get('user')?.trim().slice(0, 60) || '';
  const q = ctx.url.searchParams.get('q')?.trim().slice(0, 100) || '';
  if (q || user) {
    await consumeQuota(ctx.env, `search:${ctx.user!.id}`, SEARCHES_PER_HOUR, 3_600_000, 'Too many searches. Wait a few minutes.');
  }

  const where: string[] = [];
  const binds: unknown[] = [];
  if (user) {
    where.push('username = ?');
    binds.push(user);
  }
  if (q) {
    const like = `%${escapeLike(q)}%`;
    const cols = ['original_file_name', 'exported_file_name', 'username', 'machine', 'changes'];
    where.push(`(${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    binds.push(...cols.map(() => like));
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const listStmt = ctx.env.DB.prepare(
    `SELECT ${HISTORY_COLUMNS} FROM history ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ).bind(...binds, limit, offset);

  let total: number;
  if (!where.length) {
    total = (await ctx.env.DB.prepare("SELECT value FROM counters WHERE name = 'history_total'").first<{ value: number }>())?.value ?? 0;
  } else {
    total = (await ctx.env.DB.prepare(`SELECT COUNT(*) AS n FROM history ${whereSql}`).bind(...binds).first<{ n: number }>())?.n ?? 0;
  }
  const { results } = await listStmt.all<HistoryRow>();
  return json({ records: results.map(rowToRecord), total });
}

// GET /api/history/users  -> record count per operator (for the filter dropdown)
export async function handleHistoryUsers(ctx: Ctx): Promise<Response> {
  const { results } = await ctx.env.DB.prepare(
    'SELECT username, COUNT(*) AS count FROM history GROUP BY username ORDER BY username COLLATE NOCASE',
  ).all<{ username: string; count: number }>();
  return json({ users: results });
}

// GET /api/history/since?after=<ms>&afterId=&limit=  -> oldest-first page for CSV export / folder backup (admin)
export async function handleHistorySince(ctx: Ctx): Promise<Response> {
  const afterRaw = Number(ctx.url.searchParams.get('after') || 0);
  const after = Number.isFinite(afterRaw) ? afterRaw : 0;
  const afterId = ctx.url.searchParams.get('afterId') || '';
  const limit = intParam(ctx.url, 'limit', 500, 1, 1000);
  // (created_at, id) cursor so records sharing a timestamp are never skipped between pages.
  const { results } = await ctx.env.DB.prepare(
    `SELECT ${HISTORY_COLUMNS} FROM history WHERE created_at > ? OR (created_at = ? AND id > ?)
     ORDER BY created_at ASC, id ASC LIMIT ?`,
  )
    .bind(after, after, afterId, limit)
    .all<HistoryRow>();
  return json({ records: results.map(rowToRecord), hasMore: results.length === limit });
}

// GET /api/history/:id/code
export async function handleGetCode(ctx: Ctx): Promise<Response> {
  const id = ctx.params.id;
  const meta = await ctx.env.DB.prepare('SELECT encoding, size, chunks FROM code_files WHERE id = ?')
    .bind(id)
    .first<{ encoding: string; size: number; chunks: number }>();
  if (!meta) throw new HttpError(404, 'The G-code file for this record is not stored on the server.');
  const { results } = await ctx.env.DB.prepare('SELECT data FROM code_chunks WHERE file_id = ? ORDER BY seq').bind(id).all<{ data: string }>();
  if (results.length !== meta.chunks) throw new HttpError(500, 'Stored program file is incomplete.');
  return json({ encoding: meta.encoding, size: meta.size, data: results.map((r) => r.data).join('') });
}

function deleteHistoryStatements(env: Env, cutoff: number | null): D1PreparedStatement[] {
  const cond = cutoff === null ? '' : 'WHERE created_at < ?';
  const b = (s: D1PreparedStatement) => (cutoff === null ? s : s.bind(cutoff));
  return [
    b(env.DB.prepare(`DELETE FROM code_chunks WHERE file_id IN (SELECT id FROM history ${cond})`)),
    b(env.DB.prepare(`DELETE FROM code_files WHERE id IN (SELECT id FROM history ${cond})`)),
    b(env.DB.prepare(`DELETE FROM history ${cond}`)),
    env.DB.prepare("UPDATE counters SET value = (SELECT COUNT(*) FROM history) WHERE name = 'history_total'"),
    bumpStmt(env, 'history'),
  ];
}

// POST /api/history/prune { olderThanDays }  (admin)
export async function handlePruneHistory(ctx: Ctx): Promise<Response> {
  const body = await readJson<{ olderThanDays?: unknown }>(ctx.request, 1000);
  const days = num(body.olderThanDays, 'olderThanDays', { min: 1, max: 3650, integer: true });
  const results = await ctx.env.DB.batch(deleteHistoryStatements(ctx.env, Date.now() - days * 86_400_000));
  return json({ ok: true, deleted: results[2].meta.changes ?? 0 });
}

// DELETE /api/history  (admin: clear everything)
export async function handleClearHistory(ctx: Ctx): Promise<Response> {
  const results = await ctx.env.DB.batch(deleteHistoryStatements(ctx.env, null));
  return json({ ok: true, deleted: results[2].meta.changes ?? 0 });
}
