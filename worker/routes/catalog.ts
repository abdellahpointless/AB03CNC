import { HttpError, json, readJson } from '../http';
import type { Ctx, Env } from '../context';
import { normalizeCatalog, type CatalogTool } from '../../src/lib/toolCatalog';

/*
 * The country's tool database (A032-A034): the shop's tools, read by everyone of the country, replaced by admins only
 * (the shop's list read in the browser, checked again here; the router logs the change). Kept as one settings
 * entry; no cutting data.
 * Its routes exist only where the feature is on (regions.ts featuresOfApiPath).
 */

const KEY = 'tool_catalog';

export interface Catalog {
  tools: CatalogTool[];
  updatedAt: number | null;
  updatedBy: string | null;
}

export async function loadCatalog(env: Env): Promise<Catalog> {
  const row = await env.DB.prepare('SELECT value, updated_at FROM settings WHERE key = ?').bind(KEY).first<{ value: string; updated_at: number }>();
  if (!row) return { tools: [], updatedAt: null, updatedBy: null };
  try {
    const v = JSON.parse(row.value) as { tools?: unknown; by?: unknown };
    return { tools: normalizeCatalog(v.tools) ?? [], updatedAt: row.updated_at, updatedBy: typeof v.by === 'string' ? v.by : null };
  } catch {
    return { tools: [], updatedAt: row.updated_at, updatedBy: null };
  }
}

// GET /api/tools/catalog
export async function handleGetCatalog(ctx: Ctx): Promise<Response> {
  return json(await loadCatalog(ctx.env));
}

// PUT /api/tools/catalog { tools }  (admins: the whole list, as read from the shop's file)
export async function handleSaveCatalog(ctx: Ctx): Promise<Response> {
  const body = await readJson<{ tools?: unknown }>(ctx.request, 1_000_000);
  const tools = normalizeCatalog(body.tools);
  if (!tools) throw new HttpError(400, 'The tool database has an entry that is not valid');
  if (!tools.length) throw new HttpError(400, 'The tool database is empty');
  const now = Date.now();
  await ctx.env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(KEY, JSON.stringify({ tools, by: ctx.user!.username }), now)
    .run();
  return json({ tools, updatedAt: now, updatedBy: ctx.user!.username });
}
