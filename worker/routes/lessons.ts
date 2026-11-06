import { HttpError, intParam, json, num, readJson, str } from '../http';
import type { Ctx } from '../context';
import { consumeQuota } from '../security';

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

// POST /api/toolpath/lessons  { kind?, fileName, start, match, data }
export async function handleSaveLesson(ctx: Ctx): Promise<Response> {
  const u = ctx.user!;
  // The toolpath viewer and CAM AI both save records.
  if (u.role !== 'ADMIN' && !u.toolpathBeta && !u.camAi) throw new HttpError(403, 'The toolpath is not switched on for you.');
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
    lessons: results.slice(0, limit).map((r) => ({ id: r.id, kind: r.kind, at: new Date(r.created_at).toISOString(), user: r.username, fileName: r.file_name, start: r.start, match: r.match, ...JSON.parse(r.data) })),
  });
}
