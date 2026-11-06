import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ensureSchema } from '../schema';
import { HttpError } from '../http';
import type { AuthedUser, Ctx } from '../context';
import { handleExportLessons, handleSaveLesson } from '../routes/lessons';

// Toolpath learning records: saved by people who may use the toolpath, exported by an admin.
let mf: Miniflare;
let DB: D1Database;
const admin: AuthedUser = { id: 'u-admin', username: 'chef', role: 'ADMIN' };
const ali: AuthedUser = { id: 'u-ali', username: 'ali', role: 'MACHINIST', toolpathBeta: true };
const omar: AuthedUser = { id: 'u-omar', username: 'omar', role: 'MACHINIST' };

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-01-01', script: 'export default { fetch: () => new Response() }', d1Databases: ['DB'] }));
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  await ensureSchema(DB, 'ma');
}, 60_000);
afterAll(() => mf?.dispose());

const call = (handler: (c: Ctx) => Promise<Response>, user: AuthedUser, body?: unknown) => {
  const url = new URL('https://cnc.test/api/toolpath/lessons');
  const request = new Request(url, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  return handler({ env: { DB, REGION: 'ma' } as Ctx['env'], request, url, params: {}, user }).then(
    async (r) => ({ status: r.status, data: (await r.json()) as { lessons: Record<string, unknown>[] } }),
    (e) => (e instanceof HttpError ? { status: e.status, data: null } : Promise.reject(e)),
  );
};

describe('toolpath learning records', () => {
  it('are saved by toolpath users only, and exported with their data', async () => {
    const lesson = { fileName: 'O1042013.C60', start: 0.744, match: 1, data: { version: 1, setups: [{ n: 2, notes: ['MOD. SPANNEN F. FRONTSEITE'], changed: true }] } };
    expect((await call(handleSaveLesson, ali, lesson)).status).toBe(200);
    expect((await call(handleSaveLesson, omar, lesson)).status).toBe(403);
    expect((await call(handleSaveLesson, ali, { ...lesson, match: 2 })).status).toBe(400);
    expect((await call(handleSaveLesson, ali, { ...lesson, data: 'text' })).status).toBe(400);
    const out = await call(handleExportLessons, admin);
    expect(out.data?.lessons).toHaveLength(1);
    expect(out.data?.lessons[0]).toMatchObject({ user: 'ali', fileName: 'O1042013.C60', start: 0.744, match: 1, version: 1 });
  });
});
