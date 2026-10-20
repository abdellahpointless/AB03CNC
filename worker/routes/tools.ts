import { HttpError, json, num, optNum, readJson, str } from '../http';
import { bumpStmt, type Ctx, type Env } from '../context';
import { MACHINES, MATERIALS, TOOL_CATEGORIES, type Tool } from '../../src/types';
import { FLEET_IDS } from '../fleet';

/** Machines that may hold a tool inventory (the shop floor). Anything else is refused. */
const KNOWN_MACHINES = new Set<string>([...MACHINES, ...FLEET_IDS]);
export const MAX_TOOLS_PER_MACHINE = 400;
import { defaultToolbox } from '../../src/lib/defaultTools';

interface ToolRow {
  machine: string;
  id: string;
  sort_order: number;
  number: number;
  pocket: number | null;
  category: string;
  description: string;
  diameter: number;
  length: number;
  materials: string | null;
  changed: number;
}

export function rowToTool(r: ToolRow): Tool {
  const t: Tool = {
    id: r.id,
    number: r.number,
    category: r.category as Tool['category'],
    description: r.description,
    diameter: r.diameter,
    length: r.length,
  };
  if (r.pocket !== null && r.pocket !== undefined) t.pocket = r.pocket;
  if (r.changed) t.changed = true;
  if (r.materials) {
    try {
      const m = JSON.parse(r.materials);
      if (Array.isArray(m) && m.length) t.materials = m;
    } catch {
      /* ignore malformed */
    }
  }
  return t;
}

export function validateMachine(machine: string): string {
  const id = typeof machine === 'string' ? machine.toUpperCase() : '';
  if (!KNOWN_MACHINES.has(id)) throw new HttpError(400, 'Unknown machine');
  return id;
}

async function assertRoom(env: Env, machine: string, adding: number): Promise<void> {
  if (adding <= 0) return;
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM tools WHERE machine = ?').bind(machine).first<{ n: number }>();
  if ((row?.n ?? 0) + adding > MAX_TOOLS_PER_MACHINE) {
    throw new HttpError(400, `A machine can hold at most ${MAX_TOOLS_PER_MACHINE} tools`);
  }
}

function finiteIn(v: unknown, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : 0;
}

/** Strict validation for tools coming from the UI. */
export function parseTool(body: any, idOverride?: string): Tool {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Tool body required');
  const id = str(idOverride ?? body.id, 'Tool id', { min: 1, max: 64 });
  const category = str(body.category, 'Category', { min: 1, max: 40 });
  if (!(TOOL_CATEGORIES as string[]).includes(category)) throw new HttpError(400, `Unknown category "${category}"`);
  const materials = Array.isArray(body.materials)
    ? body.materials.filter((m: unknown) => typeof m === 'string' && (MATERIALS as string[]).includes(m))
    : [];
  const pocket = optNum(body.pocket, 'Pocket', { min: 0, max: 9999, integer: true });
  const tool: Tool = {
    id,
    number: num(body.number, 'Tool number', { min: 0, max: 999_999_999, integer: true }),
    category: category as Tool['category'],
    description: typeof body.description === 'string' ? body.description.trim().slice(0, 200) : '',
    diameter: num(body.diameter ?? 0, 'Diameter', { min: 0, max: 10_000 }),
    length: num(body.length ?? 0, 'Length', { min: 0, max: 10_000 }),
  };
  if (pocket !== null) tool.pocket = pocket;
  if (materials.length) tool.materials = materials;
  if (body.changed) tool.changed = true;
  return tool;
}

/** Lenient normalisation used when importing old data: never throws, skips junk. */
export function normalizeImportedTool(raw: any, index: number): Tool | null {
  if (!raw || typeof raw !== 'object') return null;
  const number = Number(raw.number);
  if (!Number.isFinite(number)) return null;
  const category = typeof raw.category === 'string' && (TOOL_CATEGORIES as string[]).includes(raw.category) ? raw.category : 'empty';
  const pocketNum = raw.pocket === undefined || raw.pocket === null || raw.pocket === '' ? null : Number(raw.pocket);
  const t: Tool = {
    id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 64) : `imported-${index}-${number}`,
    number: Math.round(finiteIn(number, 0, 999_999_999)),
    category: category as Tool['category'],
    description: typeof raw.description === 'string' ? raw.description.slice(0, 200) : '',
    diameter: finiteIn(raw.diameter, 0, 10_000),
    length: finiteIn(raw.length, 0, 10_000),
  };
  if (pocketNum !== null && Number.isFinite(pocketNum) && pocketNum >= 0 && pocketNum <= 9999) t.pocket = Math.round(pocketNum);
  if (Array.isArray(raw.materials) && raw.materials.length) {
    const mats = raw.materials.filter((m: unknown) => typeof m === 'string' && (MATERIALS as string[]).includes(m));
    if (mats.length) t.materials = mats;
  }
  if (raw.changed) t.changed = true;
  return t;
}

/** One statement that inserts/updates many tools for a machine (keeps array order as sort order). */
export function bulkInsertToolsStmt(env: Env, machine: string, tools: Tool[], username: string, startOrder = 0): D1PreparedStatement {
  const payload = tools.map((t) => ({
    id: t.id,
    number: t.number,
    pocket: t.pocket ?? null,
    category: t.category,
    description: t.description ?? '',
    diameter: t.diameter ?? 0,
    length: t.length ?? 0,
    materials: t.materials && t.materials.length ? JSON.stringify(t.materials) : null,
    changed: t.changed ? 1 : 0,
  }));
  return env.DB.prepare(
    `INSERT INTO tools (machine, id, sort_order, number, pocket, category, description, diameter, length, materials, changed, updated_at, updated_by)
     SELECT ?1, json_extract(value, '$.id'), ?2 + CAST(key AS INTEGER), json_extract(value, '$.number'), json_extract(value, '$.pocket'),
            json_extract(value, '$.category'), json_extract(value, '$.description'), json_extract(value, '$.diameter'),
            json_extract(value, '$.length'), json_extract(value, '$.materials'), json_extract(value, '$.changed'), ?3, ?4
     FROM json_each(?5) WHERE true
     ON CONFLICT(machine, id) DO UPDATE SET
       number = excluded.number, pocket = excluded.pocket, category = excluded.category,
       description = excluded.description, diameter = excluded.diameter, length = excluded.length,
       materials = excluded.materials, changed = excluded.changed, updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  ).bind(machine, startOrder, Date.now(), username, JSON.stringify(payload));
}

export async function seedDefaultToolsIfEmpty(env: Env, username: string): Promise<void> {
  const any = await env.DB.prepare('SELECT 1 AS x FROM tools LIMIT 1').first();
  if (any) return;
  const stmts = Object.entries(defaultToolbox).map(([machine, tools]) => bulkInsertToolsStmt(env, machine, tools || [], username));
  stmts.push(bumpStmt(env, 'tools'));
  await env.DB.batch(stmts);
}

async function loadToolbox(env: Env): Promise<Record<string, Tool[]>> {
  const { results } = await env.DB.prepare(
    'SELECT machine, id, sort_order, number, pocket, category, description, diameter, length, materials, changed FROM tools ORDER BY machine, sort_order',
  ).all<ToolRow>();
  const toolbox: Record<string, Tool[]> = {};
  for (const r of results) (toolbox[r.machine] ||= []).push(rowToTool(r));
  return toolbox;
}

// GET /api/tools
export async function handleGetTools(ctx: Ctx): Promise<Response> {
  const [toolbox, version] = await Promise.all([
    loadToolbox(ctx.env),
    ctx.env.DB.prepare("SELECT value FROM counters WHERE name = 'v_tools'").first<{ value: number }>(),
  ]);
  return json({ toolbox, version: version?.value ?? 0 });
}

async function nextSortOrder(env: Env, machine: string, id: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE((SELECT sort_order FROM tools WHERE machine = ?1 AND id = ?2),
                     (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tools WHERE machine = ?1)) AS o`,
  )
    .bind(machine, id)
    .first<{ o: number }>();
  return row?.o ?? 0;
}

// PUT /api/tools/:machine/:id  (create or update one tool)
export async function handlePutTool(ctx: Ctx): Promise<Response> {
  const machine = validateMachine(ctx.params.machine);
  const tool = parseTool(await readJson(ctx.request, 50_000), ctx.params.id);

  const conflict = await ctx.env.DB.prepare(
    `SELECT id FROM tools WHERE machine = ? AND number = ? AND id != ? AND category != 'empty' LIMIT 1`,
  )
    .bind(machine, tool.number, tool.id)
    .first();
  if (conflict) throw new HttpError(409, `T-number ${tool.number} is already used by another tool!`);

  const isNew = !(await ctx.env.DB.prepare('SELECT 1 AS x FROM tools WHERE machine = ? AND id = ?').bind(machine, tool.id).first());
  if (isNew) await assertRoom(ctx.env, machine, 1);
  const order = await nextSortOrder(ctx.env, machine, tool.id);
  await ctx.env.DB.batch([
    // An empty slot carrying the same T-number is replaced by this tool.
    ctx.env.DB.prepare('DELETE FROM tools WHERE machine = ? AND number = ? AND id != ?').bind(machine, tool.number, tool.id),
    bulkInsertToolsStmt(ctx.env, machine, [tool], ctx.user!.username, order),
    bumpStmt(ctx.env, 'tools'),
  ]);
  return json({ tool });
}

// POST /api/tools/:machine/batch  { tools: Tool[] }  (tools approved from the remapper)
export async function handleBatchTools(ctx: Ctx): Promise<Response> {
  const machine = validateMachine(ctx.params.machine);
  const body = await readJson<{ tools?: unknown[] }>(ctx.request, 200_000);
  if (!Array.isArray(body.tools) || body.tools.length === 0 || body.tools.length > 100) {
    throw new HttpError(400, 'tools must be a non-empty array (max 100)');
  }
  const tools = body.tools.map((t) => parseTool(t));
  const stmts: D1PreparedStatement[] = [];
  // One query for every existing row of this machine (instead of one query per tool).
  const { results: rows } = await ctx.env.DB.prepare('SELECT id, number, sort_order FROM tools WHERE machine = ?')
    .bind(machine)
    .all<{ id: string; number: number; sort_order: number }>();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const byNumber = new Map<number, { id: string; number: number; sort_order: number }>();
  for (const r of rows) if (!byNumber.has(r.number)) byNumber.set(r.number, r);
  let maxOrder = rows.reduce((m, r) => Math.max(m, r.sort_order), -1);
  const added = tools.filter((t) => !byId.has(t.id) && !byNumber.has(t.number)).length;
  if (rows.length + added > MAX_TOOLS_PER_MACHINE) throw new HttpError(400, `A machine can hold at most ${MAX_TOOLS_PER_MACHINE} tools`);

  for (const tool of tools) {
    // Same behaviour as before: the new tool takes the place of a tool with the same id or T-number.
    const existing = byId.get(tool.id) ?? byNumber.get(tool.number);
    const order = existing ? existing.sort_order : ++maxOrder;
    const placed = { id: tool.id, number: tool.number, sort_order: order };
    byId.set(tool.id, placed);
    byNumber.set(tool.number, placed);
    stmts.push(ctx.env.DB.prepare('DELETE FROM tools WHERE machine = ? AND number = ? AND id != ?').bind(machine, tool.number, tool.id));
    stmts.push(bulkInsertToolsStmt(ctx.env, machine, [{ ...tool, changed: true }], ctx.user!.username, order));
  }
  stmts.push(bumpStmt(ctx.env, 'tools'));
  await ctx.env.DB.batch(stmts);
  return json({ ok: true, count: tools.length });
}

// DELETE /api/tools/:machine/:id
export async function handleDeleteTool(ctx: Ctx): Promise<Response> {
  const machine = validateMachine(ctx.params.machine);
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('DELETE FROM tools WHERE machine = ? AND id = ?').bind(machine, ctx.params.id),
    bumpStmt(ctx.env, 'tools'),
  ]);
  return json({ ok: true });
}

// POST /api/tools/:machine/:id/ack  (clear the orange "modified" marker)
export async function handleAckTool(ctx: Ctx): Promise<Response> {
  const machine = validateMachine(ctx.params.machine);
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('UPDATE tools SET changed = 0 WHERE machine = ? AND id = ?').bind(machine, ctx.params.id),
    bumpStmt(ctx.env, 'tools'),
  ]);
  return json({ ok: true });
}
