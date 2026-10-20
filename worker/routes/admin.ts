import { HttpError, json, readJson } from '../http';
import { bumpStmt, newId, type Ctx } from '../context';
import { assertNotMasterUsername, hashPassword, validateUsername } from '../auth';
import { MAX_TOOLS_PER_MACHINE, bulkInsertToolsStmt, normalizeImportedTool, parseTool, validateMachine } from './tools';
import { codeStatements, historyInsertStatements, normalizeHistory, parseCode } from './history';
import { validateSap } from './parts';
import { DEFAULT_SAVED_SECONDS } from './analytics';
import type { Tool } from '../../src/types';

/**
 * Import endpoints used by "Restore from backup". The browser sends data in small batches so each
 * request stays inside the Workers Free CPU budget.
 */

// POST /api/admin/import/users { users: [{ id?, username, password?, role?, created_at? }] }  (max 3 per request)
export async function handleImportUsers(ctx: Ctx): Promise<Response> {
  const body = await readJson<{ users?: any[] }>(ctx.request, 50_000);
  if (!Array.isArray(body.users) || body.users.length > 3) throw new HttpError(400, 'users must be an array (max 3 per request)');

  const idMap: Record<string, string> = {};
  const created: string[] = [];
  const skipped: string[] = [];
  for (const u of body.users) {
    let username: string;
    try {
      username = validateUsername(typeof u?.username === 'string' ? u.username.trim() : '');
    } catch {
      if (typeof u?.username === 'string' && u.username.trim()) skipped.push(`${u.username.slice(0, 40)} (invalid username)`);
      continue;
    }
    const oldId = u?.id !== undefined && u?.id !== null ? String(u.id).slice(0, 64) : '';
    const existing = await ctx.env.DB.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').bind(username).first<{ id: string }>();
    if (existing) {
      if (oldId) idMap[oldId] = existing.id;
      skipped.push(username);
      continue;
    }
    try {
      await assertNotMasterUsername(ctx.env, username);
    } catch {
      skipped.push(`${username} (reserved name)`);
      continue;
    }
    // Old accounts keep their password so people can still sign in; they are asked to pick a
    // stronger one afterwards. Only empty or absurd values are refused.
    const password = typeof u.password === 'string' && u.password.length >= 4 && u.password.length <= 200 ? u.password : null;
    if (!password) {
      skipped.push(`${username} (no usable password)`);
      continue;
    }
    // Always a fresh id: a re-used id could inherit a deleted user's data.
    const id = newId();
    const role = u.role === 'ADMIN' ? 'ADMIN' : 'MACHINIST';
    const parsed = Date.parse(u.created_at);
    const createdAt = Number.isFinite(parsed) && parsed > 0 && parsed <= Date.now() ? parsed : Date.now();
    await ctx.env.DB.prepare('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, username, await hashPassword(ctx.env, password), role, createdAt)
      .run();
    if (oldId) idMap[oldId] = id;
    created.push(username);
  }
  if (created.length) await bumpStmt(ctx.env, 'users').run();
  return json({ idMap, created, skipped });
}

// POST /api/admin/import/tools { toolbox: { [machine]: Tool[] }, mode: 'replace' | 'merge' }
export async function handleImportTools(ctx: Ctx): Promise<Response> {
  const body = await readJson<{ toolbox?: Record<string, unknown>; mode?: string }>(ctx.request, 5_000_000);
  if (!body.toolbox || typeof body.toolbox !== 'object') throw new HttpError(400, 'toolbox object required');
  const stmts: D1PreparedStatement[] = [];
  if (body.mode === 'replace') stmts.push(ctx.env.DB.prepare('DELETE FROM tools'));
  let count = 0;
  for (const [machineRaw, list] of Object.entries(body.toolbox)) {
    if (!Array.isArray(list)) continue;
    if (list.length > MAX_TOOLS_PER_MACHINE) throw new HttpError(400, `${machineRaw}: at most ${MAX_TOOLS_PER_MACHINE} tools per machine`);
    let machine: string;
    try {
      machine = await validateMachine(ctx.env, machineRaw);
    } catch {
      continue; // a machine that no longer exists on the floor is skipped, not fatal
    }
    const seen = new Set<string>();
    const tools = list
      .map((t, i) => normalizeImportedTool(t, i))
      .filter((t): t is Tool => {
        if (!t || seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
      });
    if (!tools.length) continue;
    if (body.mode !== 'replace') stmts.push(ctx.env.DB.prepare('DELETE FROM tools WHERE machine = ?').bind(machine));
    stmts.push(bulkInsertToolsStmt(ctx.env, machine, tools, ctx.user!.username));
    count += tools.length;
  }
  stmts.push(bumpStmt(ctx.env, 'tools'));
  await ctx.env.DB.batch(stmts);
  return json({ ok: true, count });
}

// POST /api/admin/import/tools-excel { machines: { [machine]: Tool[] }, mode: 'update' | 'replace' }
// Used by the Excel import in the tool inventory. Every tool is validated strictly.
//  - update:  tools with the same T-number as an existing one replace it; other tools are kept
//  - replace: each machine listed gets exactly the tools in the file (machines not listed are untouched)
export async function handleImportToolsExcel(ctx: Ctx): Promise<Response> {
  const body = await readJson<{ machines?: Record<string, unknown>; mode?: string }>(ctx.request, 2_000_000);
  const mode = body.mode === 'replace' ? 'replace' : body.mode === 'update' ? 'update' : null;
  if (!mode) throw new HttpError(400, "mode must be 'update' or 'replace'");
  if (!body.machines || typeof body.machines !== 'object' || Array.isArray(body.machines)) throw new HttpError(400, 'machines object required');
  const entries = Object.entries(body.machines);
  if (!entries.length || entries.length > 20) throw new HttpError(400, 'Between 1 and 20 machines per import');

  const stmts: D1PreparedStatement[] = [];
  const summary: { machine: string; added: number; updated: number; total: number }[] = [];
  for (const [machineRaw, list] of entries) {
    const machine = await validateMachine(ctx.env, machineRaw);
    if (!Array.isArray(list) || !list.length) throw new HttpError(400, `${machineRaw}: no tools`);
    if (list.length > MAX_TOOLS_PER_MACHINE) throw new HttpError(400, `${machine}: at most ${MAX_TOOLS_PER_MACHINE} tools per machine`);

    const numbers = new Set<number>();
    const incoming = list.map((raw, i) => {
      const tool = parseTool({ ...(raw as object), id: 'x' }, 'x');
      if (numbers.has(tool.number)) throw new HttpError(400, `${machine}: T${tool.number} appears twice (entry ${i + 1})`);
      numbers.add(tool.number);
      return tool;
    });

    const { results: existing } = await ctx.env.DB.prepare('SELECT id, number, sort_order FROM tools WHERE machine = ?')
      .bind(machine)
      .all<{ id: string; number: number; sort_order: number }>();
    const idByNumber = new Map<number, string>();
    for (const e of existing) if (!idByNumber.has(e.number)) idByNumber.set(e.number, e.id);
    const maxOrder = existing.reduce((m, e) => Math.max(m, e.sort_order), -1);

    let tools;
    let startOrder: number;
    let updated = 0;
    if (mode === 'replace') {
      stmts.push(ctx.env.DB.prepare('DELETE FROM tools WHERE machine = ?').bind(machine));
      tools = incoming.map((t) => ({ ...t, id: newId().slice(0, 13) }));
      startOrder = 0;
    } else {
      // Same T-number -> same row (keeps its id and position); anything else is added at the end.
      tools = incoming.map((t) => {
        const keep = idByNumber.get(t.number);
        if (keep) updated++;
        return { ...t, id: keep ?? newId().slice(0, 13), changed: true };
      });
      startOrder = maxOrder + 1;
      if (existing.length + tools.length - updated > MAX_TOOLS_PER_MACHINE) {
        throw new HttpError(400, `${machine}: a machine can hold at most ${MAX_TOOLS_PER_MACHINE} tools`);
      }
    }
    stmts.push(bulkInsertToolsStmt(ctx.env, machine, tools, ctx.user!.username, startOrder));
    summary.push({ machine, added: tools.length - updated, updated, total: tools.length });
  }
  stmts.push(bumpStmt(ctx.env, 'tools'));
  await ctx.env.DB.batch(stmts);
  return json({ ok: true, summary });
}

// POST /api/admin/import/history { records: HistoryRecord[], codes?: { [id]: CodePayload } }  (max 200 records)
export async function handleImportHistory(ctx: Ctx): Promise<Response> {
  const body = await readJson<{ records?: any[]; codes?: Record<string, unknown> }>(ctx.request, 30_000_000);
  if (!Array.isArray(body.records) || body.records.length > 200) throw new HttpError(400, 'records must be an array (max 200)');
  const normalized = body.records.map((r) => normalizeHistory(r, 'Unknown', false)).filter((r) => r !== null);
  if (!normalized.length) return json({ inserted: 0, skipped: body.records.length });

  const { results: existing } = await ctx.env.DB.prepare('SELECT id FROM history WHERE id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(normalized.map((r) => r.id)))
    .all<{ id: string }>();
  const existingIds = new Set(existing.map((r) => r.id));
  const seen = new Set<string>();
  const fresh = normalized.filter((r) => {
    if (existingIds.has(r.id) || seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });

  const stmts: D1PreparedStatement[] = [];
  for (const h of fresh) {
    const code = body.codes ? parseCode(body.codes[h.id]) : null;
    stmts.push(...historyInsertStatements(ctx.env, h, !!code));
    if (code) stmts.push(...codeStatements(ctx.env, h.id, code, h.createdAt));
  }
  if (stmts.length) {
    stmts.push(bumpStmt(ctx.env, 'history'));
    await ctx.env.DB.batch(stmts);
  }
  return json({ inserted: fresh.length, skipped: body.records.length - fresh.length });
}

// POST /api/admin/import/code { id, code: CodePayload }  -> attach a program file to an existing record
export async function handleImportCode(ctx: Ctx): Promise<Response> {
  const body = await readJson<{ id?: string; code?: unknown }>(ctx.request, 50_000_000);
  const id = typeof body.id === 'string' ? body.id : '';
  const code = parseCode(body.code);
  if (!id || !code) throw new HttpError(400, 'id and code are required');
  const rec = await ctx.env.DB.prepare('SELECT created_at, has_code FROM history WHERE id = ?').bind(id).first<{ created_at: number; has_code: number }>();
  if (!rec) return json({ ok: false, reason: 'no matching history record' });
  if (rec.has_code) return json({ ok: true, skipped: true });
  await ctx.env.DB.batch([
    ...codeStatements(ctx.env, id, code, rec.created_at),
    ctx.env.DB.prepare('UPDATE history SET has_code = 1 WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
}

// POST /api/admin/import/parts { entries: PartEntry[], idMap?: { oldUserId: newUserId } }  (max 300)
export async function handleImportParts(ctx: Ctx): Promise<Response> {
  const body = await readJson<{ entries?: any[]; idMap?: Record<string, string> }>(ctx.request, 2_000_000);
  if (!Array.isArray(body.entries) || body.entries.length > 300) throw new HttpError(400, 'entries must be an array (max 300)');
  const idMap = body.idMap && typeof body.idMap === 'object' ? body.idMap : {};
  const rows: any[] = [];
  for (const e of body.entries) {
    try {
      const qty = Math.round(Number(e.qty));
      const kind = e.kind === 'MODIFICATION' ? 'MODIFICATION' : 'PRODUCED';
      const status = ['PENDING', 'APPROVED', 'REJECTED'].includes(e.status) ? e.status : 'PENDING';
      const createdAt = typeof e.created_at === 'string' && !Number.isNaN(Date.parse(e.created_at)) ? e.created_at : new Date().toISOString();
      const userId = String(e.user_id ?? '');
      if (!e.id || !userId || !Number.isFinite(qty) || qty < 1) continue;
      rows.push({
        id: String(e.id).slice(0, 64),
        user_id: idMap[userId] ?? userId,
        username: String(e.username ?? '').slice(0, 60),
        sap_number: validateSap(e.sap_number),
        qty: Math.min(qty, 9999),
        kind,
        unit_value: [0, 0.5, 1].includes(Number(e.unit_value)) ? Number(e.unit_value) : kind === 'PRODUCED' ? 1 : 0.5,
        status,
        month_key: /^\d{4}-\d{2}$/.test(e.month_key) ? e.month_key : createdAt.slice(0, 7),
        created_at: createdAt,
        reviewed_at: typeof e.reviewed_at === 'string' && !Number.isNaN(Date.parse(e.reviewed_at)) ? e.reviewed_at.slice(0, 40) : null,
        reviewed_by: typeof e.reviewed_by === 'string' ? e.reviewed_by.slice(0, 60) : null,
      });
    } catch {
      /* skip invalid row */
    }
  }
  // Entries must belong to a real account; the stored username always comes from that account.
  const { results: users } = await ctx.env.DB.prepare('SELECT id, username FROM users WHERE id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify([...new Set(rows.map((r) => r.user_id))]))
    .all<{ id: string; username: string }>();
  const names = new Map(users.map((u) => [u.id, u.username]));
  const valid = rows.filter((r) => names.has(r.user_id)).map((r) => ({ ...r, username: names.get(r.user_id) }));
  rows.length = 0;
  rows.push(...valid);
  if (!rows.length) return json({ inserted: 0 });
  const [res] = await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `INSERT OR IGNORE INTO part_entries (id, user_id, username, sap_number, qty, kind, unit_value, status, month_key, created_at, reviewed_at, reviewed_by)
       SELECT json_extract(value, '$.id'), json_extract(value, '$.user_id'), json_extract(value, '$.username'), json_extract(value, '$.sap_number'),
              json_extract(value, '$.qty'), json_extract(value, '$.kind'), json_extract(value, '$.unit_value'), json_extract(value, '$.status'),
              json_extract(value, '$.month_key'), json_extract(value, '$.created_at'), json_extract(value, '$.reviewed_at'), json_extract(value, '$.reviewed_by')
       FROM json_each(?)`,
    ).bind(JSON.stringify(rows)),
    bumpStmt(ctx.env, 'parts'),
  ]);
  return json({ inserted: res.meta.changes ?? 0 });
}

// POST /api/admin/import/settings { savedSecondsPerExtraction? }
export async function handleImportSettings(ctx: Ctx): Promise<Response> {
  const body = await readJson<{ savedSecondsPerExtraction?: unknown }>(ctx.request, 5000);
  const s = Number(body.savedSecondsPerExtraction);
  const seconds = Number.isInteger(s) && s > 0 && s <= 3600 ? s : DEFAULT_SAVED_SECONDS;
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('saved_seconds_per_extraction', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(String(seconds), Date.now()),
    bumpStmt(ctx.env, 'settings'),
  ]);
  return json({ ok: true });
}
