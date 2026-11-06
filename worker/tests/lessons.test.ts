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

const call = (handler: (c: Ctx) => Promise<Response>, user: AuthedUser, body?: unknown, query = '') => {
  const url = new URL(`https://cnc.test/api/toolpath/lessons${query}`);
  const request = new Request(url, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  return handler({ env: { DB, REGION: 'ma' } as Ctx['env'], request, url, params: {}, user }).then(
    async (r) => ({ status: r.status, data: (await r.json()) as { lessons: Record<string, unknown>[]; more: boolean } }),
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
    expect(out.data?.lessons[0]).toMatchObject({ kind: 'turns', user: 'ali', fileName: 'O1042013.C60', start: 0.744, match: 1, version: 1 });
  });

  it('keep big part records (model + program) apart, exported page by page', async () => {
    const part = { kind: 'part', fileName: 'O2504411.000', start: 1, match: 1, data: { version: 1, model: 'x'.repeat(1_000_000), program: 'y' } };
    expect((await call(handleSaveLesson, ali, part)).status).toBe(200);
    expect((await call(handleSaveLesson, ali, { ...part, fileName: 'O1.000' })).status).toBe(200);
    expect((await call(handleSaveLesson, ali, { ...part, data: { model: 'x'.repeat(2_000_000) } })).status).toBe(413);
    expect((await call(handleSaveLesson, ali, { ...part, kind: 'other' })).status).toBe(400);
    // A turns record that big is refused.
    expect((await call(handleSaveLesson, ali, { ...part, kind: 'turns' })).status).toBe(413);
    const page1 = await call(handleExportLessons, admin, undefined, '?kind=part&limit=1');
    expect(page1.data?.lessons).toHaveLength(1);
    expect(page1.data?.more).toBe(true);
    const page2 = await call(handleExportLessons, admin, undefined, '?kind=part&limit=1&offset=1');
    expect(page2.data?.more).toBe(false);
    expect((page2.data?.lessons[0] as { model: string }).model).toHaveLength(1_000_000);
    expect((await call(handleExportLessons, admin, undefined, '?kind=turns')).data?.lessons).toHaveLength(1);
    expect((await call(handleExportLessons, admin, undefined, `?kind=part&from=${Date.now() + 60_000}`)).data?.lessons).toHaveLength(0);
  });
});
