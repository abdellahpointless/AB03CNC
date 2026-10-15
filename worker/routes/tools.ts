import { HttpError, json, num, optNum, readJson, str } from '../http';
import { bumpStmt, type Ctx, type Env } from '../context';
import { MATERIALS, TOOL_CATEGORIES, type Tool } from '../../src/types';
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
  if (!/^[A-Z0-9][A-Z0-9_-]{0,23}$/i.test(machine)) throw new HttpError(400, 'Invalid machine id');
  return machine.toUpperCase();
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
  const category = typeof raw.category === 'string' && raw.category ? raw.category : 'empty';
  const pocketNum = raw.pocket === undefined || raw.pocket === null || raw.pocket === '' ? null : Number(raw.pocket);
  const t: Tool = {
    id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 64) : `imported-${index}-${number}`,
    number: Math.round(number),
    category: category.slice(0, 40) as Tool['category'],
    description: typeof raw.description === 'string' ? raw.description.slice(0, 200) : '',
    diameter: Number(raw.diameter) || 0,
    length: Number(raw.length) || 0,
  };
  if (pocketNum !== null && Number.isFinite(pocketNum)) t.pocket = Math.round(pocketNum);
  if (Array.isArray(raw.materials) && raw.materials.length) t.materials = raw.materials.filter((m: unknown) => typeof m === 'string');
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
  let maxOrder = (
    await ctx.env.DB.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM tools WHERE machine = ?').bind(machine).first<{ m: number }>()
  )?.m ?? -1;

  for (const tool of tools) {
    // Same behaviour as before: the new tool takes the place of a tool with the same id or T-number.
    const existing = await ctx.env.DB.prepare(
      'SELECT id, sort_order FROM tools WHERE machine = ? AND (id = ? OR number = ?) ORDER BY (id = ?) DESC LIMIT 1',
    )
      .bind(machine, tool.id, tool.number, tool.id)
      .first<{ id: string; sort_order: number }>();
    const order = existing ? existing.sort_order : ++maxOrder;
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
