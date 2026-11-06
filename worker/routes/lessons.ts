import { HttpError, json, num, readJson, str } from '../http';
import type { Ctx } from '../context';
import { consumeQuota } from '../security';

/*
 * Learning records of the toolpath's turn search (see src/lib/lessons.ts): saved by anyone who may
 * use the toolpath, downloaded all at once by an admin to improve how the app reads the turns.
 */

const MAX_BYTES = 256 * 1024;
const PER_DAY = 200;
const MAX_EXPORT = 5000;

// POST /api/toolpath/lessons  { fileName, start, match, data }
export async function handleSaveLesson(ctx: Ctx): Promise<Response> {
  const u = ctx.user!;
  if (u.role !== 'ADMIN' && !u.toolpathBeta) throw new HttpError(403, 'The toolpath is not switched on for you.');
  const body = await readJson<{ fileName?: unknown; start?: unknown; match?: unknown; data?: unknown }>(ctx.request, MAX_BYTES + 4096);
  const fileName = str(body.fileName, 'fileName', { max: 200, min: 1 });
  const start = num(body.start, 'start', { min: 0, max: 1 });
  const match = num(body.match, 'match', { min: 0, max: 1 });
  if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) throw new HttpError(400, 'data must be an object');
  const data = JSON.stringify(body.data);
  if (data.length > MAX_BYTES) throw new HttpError(413, 'The record is too big.');
  await consumeQuota(ctx.env, `lesson:${u.id}`, PER_DAY, 86_400_000, 'Daily limit of learning records reached.');
  await ctx.env.DB.prepare('INSERT INTO turn_lessons (id, created_at, username, file_name, start, match, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), Date.now(), u.username, fileName, start, match, data)
    .run();
  return json({ ok: true });
}

// GET /api/toolpath/lessons  -> every record, newest first (admin)
export async function handleExportLessons(ctx: Ctx): Promise<Response> {
  const { results } = await ctx.env.DB.prepare('SELECT id, created_at, username, file_name, start, match, data FROM turn_lessons ORDER BY created_at DESC LIMIT ?')
    .bind(MAX_EXPORT)
    .all<{ id: string; created_at: number; username: string; file_name: string; start: number; match: number; data: string }>();
  return json({
    region: ctx.env.REGION,
    exportedAt: new Date().toISOString(),
    lessons: results.map((r) => ({ id: r.id, at: new Date(r.created_at).toISOString(), user: r.username, fileName: r.file_name, start: r.start, match: r.match, ...JSON.parse(r.data) })),
  });
}
