import { HttpError, intParam, json, num, readJson, str } from '../http';
import type { Ctx } from '../context';
import { consumeQuota } from '../security';
import { ensureSchema } from '../schema';
import { camAllowed, readFeatures } from '../features';
import { regionById } from '../../src/regions';

/*
 * Learning records (see src/lib/lessons.ts), saved by anyone who may use the toolpath and
 * downloaded by an admin to improve the app:
 *   turns: a turn search (what the M0 comments say, how the app read them, the right turns);
 *   part:  a program checked with its 3D model, or made by CAM AI: the model and the program
 *          (gzip, base64), the features and how each was machined.
 */

const KINDS = ['turns', 'part'] as const;
type Kind = (typeof KINDS)[number];
/** D1 keeps a row under 2 MB: a part record with its model must stay below. */
const MAX_BYTES: Record<Kind, number> = { turns: 256 * 1024, part: 1_900_000 };
const PER_DAY: Record<Kind, number> = { turns: 200, part: 300 };

/**
 * The toolpath viewer and CAM AI both save records: the viewer's people (admins, toolpath beta)
 * where the toolpath is on in the country, CAM AI's (admins, CAM AI) where CAM AI is on.
 */
async function requireToolpath(ctx: Ctx): Promise<void> {
  const u = ctx.user!;
  const region = regionById(ctx.env.REGION);
  const f = region ? await readFeatures(ctx.env.DB, region.id) : null;
  const admin = u.role === 'ADMIN';
  if (!f || !((f.toolpath && (admin || u.toolpathBeta)) || camAllowed(region?.id, u, f))) throw new HttpError(403, 'The toolpath is not switched on for you.');
}

// POST /api/toolpath/lessons  { kind?, fileName, start, match, data }
export async function handleSaveLesson(ctx: Ctx): Promise<Response> {
  const u = ctx.user!;
  await requireToolpath(ctx);
  const body = await readJson<{ kind?: unknown; fileName?: unknown; start?: unknown; match?: unknown; data?: unknown }>(ctx.request, MAX_BYTES.part + 8192);
  const kind = (body.kind ?? 'turns') as Kind;
  if (!KINDS.includes(kind)) throw new HttpError(400, 'kind must be turns or part');
  const fileName = str(body.fileName, 'fileName', { max: 200, min: 1 });
  const start = num(body.start, 'start', { min: 0, max: 1 });
  const match = num(body.match, 'match', { min: 0, max: 1 });
  if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) throw new HttpError(400, 'data must be an object');
  const data = JSON.stringify(body.data);
  if (data.length > MAX_BYTES[kind]) throw new HttpError(413, 'The record is too big.');
  await consumeQuota(ctx.env, `lesson:${kind}:${u.id}`, PER_DAY[kind], 86_400_000, 'Daily limit of learning records reached.');
  await ctx.env.DB.prepare('INSERT INTO turn_lessons (id, created_at, username, file_name, start, match, data, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), Date.now(), u.username, fileName, start, match, data, kind)
    .run();
  return json({ ok: true });
}

// GET /api/toolpath/lessons?from=&to=&kind=&offset=&limit=  -> one page of records, newest first (admin)
export async function handleExportLessons(ctx: Ctx): Promise<Response> {
  const q = ctx.url.searchParams;
  const from = intParam(ctx.url, 'from', 0, 0, 8_640_000_000_000);
  const to = intParam(ctx.url, 'to', 8_640_000_000_000, 0, 8_640_000_000_000);
  const kind = q.get('kind');
  if (kind !== null && !KINDS.includes(kind as Kind)) throw new HttpError(400, 'kind must be turns or part');
  // Part records are big: smaller pages.
  const limit = intParam(ctx.url, 'limit', kind === 'turns' ? 500 : 25, 1, kind === 'turns' ? 1000 : 50);
  const offset = intParam(ctx.url, 'offset', 0, 0, 1_000_000);
  const { results } = await ctx.env.DB.prepare(
    `SELECT id, created_at, username, file_name, start, match, data, kind FROM turn_lessons
     WHERE created_at >= ? AND created_at < ? AND (? IS NULL OR kind = ?) ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(from, to, kind, kind, limit + 1, offset)
    .all<{ id: string; created_at: number; username: string; file_name: string; start: number; match: number; data: string; kind: Kind }>();
  return json({
    region: ctx.env.REGION,
    exportedAt: new Date().toISOString(),
    more: results.length > limit,
    // The server's own fields last: the stored data cannot pretend to be someone else's record.
    lessons: results.slice(0, limit).map((r) => ({ ...JSON.parse(r.data), id: r.id, kind: r.kind, at: new Date(r.created_at).toISOString(), user: r.username, fileName: r.file_name, start: r.start, match: r.match })),
  });
}

// ---- Turns learned from 3D models (shared by every country, in the master hub) ---------------

const TURN = /^-?[01](?:,-?[01]){8}$/;

/** The shared memory: the hub when the country has one (the deployed app), else its own database. */
async function memoryDb(ctx: Ctx): Promise<D1Database> {
  const hub = ctx.env.HUB;
  if (!hub) return ctx.env.DB;
  await ensureSchema(hub, 'master');
  return hub;
}

// POST /api/toolpath/memory { entries: [{ key, rel, n? }] }  turns a 3D check found right; an admin
// may import many at once with their counts (learning from a folder of programs and models).
export async function handleSaveTurnMemory(ctx: Ctx): Promise<Response> {
  const u = ctx.user!;
  await requireToolpath(ctx);
  const admin = u.role === 'ADMIN';
  const body = await readJson<{ entries?: unknown }>(ctx.request, admin ? 2_000_000 : 50_000);
  if (!Array.isArray(body.entries) || !body.entries.length || body.entries.length > (admin ? 5000 : 60)) throw new HttpError(400, 'entries must be a list');
  const entries = body.entries.map((e: { key?: unknown; rel?: unknown; n?: unknown }) => {
    const key = str(e?.key, 'key', { min: 1, max: 600 });
    const rel = str(e?.rel, 'rel', { min: 17, max: 26 });
    if (!TURN.test(rel)) throw new HttpError(400, 'rel must be a turn');
    // One check counts once; an admin import carries the counts it found.
    const n = admin && e?.n !== undefined ? num(e.n, 'n', { min: 1, max: 1000, integer: true }) : 1;
    return { key, rel, n };
  });
  await consumeQuota(ctx.env, `turn-memory:${u.id}`, admin ? 50 : 100, 86_400_000, 'Daily limit of learning records reached.');
  const db = await memoryDb(ctx);
  const now = Date.now();
  await db.batch(
    entries.map((e) =>
      db
        .prepare('INSERT INTO turn_memory (key, rel, n, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key, rel) DO UPDATE SET n = n + excluded.n, updated_at = excluded.updated_at')
        .bind(e.key, e.rel, e.n, now),
    ),
  );
  return json({ ok: true, saved: entries.length });
}

// GET /api/toolpath/memory -> every learned turn (small: one row per wording and turn)
export async function handleGetTurnMemory(ctx: Ctx): Promise<Response> {
  const db = await memoryDb(ctx);
  const { results } = await db.prepare('SELECT key, rel, n FROM turn_memory ORDER BY n DESC LIMIT 20000').all<{ key: string; rel: string; n: number }>();
  return json({ rows: results });
}
