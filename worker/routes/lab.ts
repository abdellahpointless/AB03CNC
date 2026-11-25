import { HttpError, json, readJson } from '../http';
import type { Ctx } from '../context';
import { camAllowed, readFeatures } from '../features';
import { auditCtx } from '../security';
import { regionById } from '../../src/regions';
import { cleanDbTool } from '../../src/lib/cam/toolDb';

/*
 * The shop's tool database for the lab (src/lib/cam/toolDb.ts): template tools removed or given their own
 * cutting data, tools added. One row per family and tool code; deleting the row gives the template back.
 * Only for those who may use the lab; for anyone else it does not exist (404, as an unknown path).
 */

/** Rows a country's database keeps (every template changed, and tools added, with room to spare). */
export const MAX_LAB_TOOLS = 1000;

async function requireLab(ctx: Ctx): Promise<void> {
  const region = regionById(ctx.env.REGION);
  const f = region ? await readFeatures(ctx.env.DB, region.id) : null;
  if (!f || !camAllowed(region?.id, ctx.user!, f)) throw new HttpError(404, 'Not found');
}

// GET /api/lab/tools  -> every changed or added tool
export async function handleListLabTools(ctx: Ctx): Promise<Response> {
  await requireLab(ctx);
  const { results } = await ctx.env.DB.prepare('SELECT family, code, data, updated_by, updated_at FROM lab_tools ORDER BY family, code').all<{
    family: string;
    code: string;
    data: string;
    updated_by: string;
    updated_at: number;
  }>();
  // A row the planner may no longer take (rules changed since) is left out.
  const tools = results.flatMap((r) => {
    let data: unknown = null;
    try {
      data = JSON.parse(r.data);
    } catch {
      /* a damaged row is left out */
    }
    const tool = cleanDbTool(r.family, r.code, data);
    return tool ? [{ family: r.family, code: r.code, tool, by: r.updated_by, at: r.updated_at }] : [];
  });
  return json({ tools });
}

// PUT /api/lab/tools  { family, code, tool }
export async function handleSaveLabTool(ctx: Ctx): Promise<Response> {
  await requireLab(ctx);
  const body = await readJson<{ family?: unknown; code?: unknown; tool?: unknown }>(ctx.request, 8192);
  const tool = cleanDbTool(body.family, body.code, body.tool);
  if (!tool) throw new HttpError(400, 'Invalid tool');
  const known = await ctx.env.DB.prepare('SELECT 1 FROM lab_tools WHERE family = ? AND code = ?').bind(body.family, body.code).first();
  if (!known) {
    const n = await ctx.env.DB.prepare('SELECT COUNT(*) AS n FROM lab_tools').first<{ n: number }>();
    if ((n?.n ?? 0) >= MAX_LAB_TOOLS) throw new HttpError(409, 'The tool database is full.');
  }
  await ctx.env.DB.prepare(
    `INSERT INTO lab_tools (family, code, data, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (family, code) DO UPDATE SET data = excluded.data, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  )
    .bind(body.family, body.code, JSON.stringify(tool), ctx.user!.username, Date.now())
    .run();
  await auditCtx(ctx, 'lab_tool_saved', `${body.family} ${body.code}`);
  return json({ ok: true });
}

// DELETE /api/lab/tools?family=&code=  -> the template's own again (an added tool: gone)
export async function handleResetLabTool(ctx: Ctx): Promise<Response> {
  await requireLab(ctx);
  const family = ctx.url.searchParams.get('family');
  const code = ctx.url.searchParams.get('code');
  if (!cleanDbTool(family, code, { removed: true })) throw new HttpError(400, 'Invalid tool');
  await ctx.env.DB.prepare('DELETE FROM lab_tools WHERE family = ? AND code = ?').bind(family, code).run();
  await auditCtx(ctx, 'lab_tool_reset', `${family} ${code}`);
  return json({ ok: true });
}
