import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ensureSchema } from '../schema';
import { HttpError } from '../http';
import type { AuthedUser, Ctx } from '../context';
import { handleGetCatalog, handleSaveCatalog } from '../routes/catalog';
import { handleBatchTools, handlePutTool } from '../routes/tools';
import { featuresOfApiPath } from '../../src/regions';

// Türkiye's tool database (A032-A034): admins replace it; everyone else adds a tool to a machine only from it.
let mf: Miniflare;
let DB: D1Database;
const admin: AuthedUser = { id: 'u-admin', username: 'sef', role: 'ADMIN' };
const ali: AuthedUser = { id: 'u-ali', username: 'ali', role: 'MACHINIST' };

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-01-01', script: 'export default { fetch: () => new Response() }', d1Databases: ['DB'] }));
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  await ensureSchema(DB, 'tr');
  await DB.prepare("INSERT INTO machines (id, name, brand, model, pockets, has_tools, active, sort, created_at) VALUES ('HAAS-F', 'HAAS F', 'HAAS', '', 41, 1, 1, 10, 0)").run();
}, 60_000);
afterAll(() => mf?.dispose());

type Out = { status: number; data: any };
const call = (handler: (c: Ctx) => Promise<Response>, user: AuthedUser, opts: { method?: string; body?: unknown; params?: Record<string, string>; region?: string } = {}): Promise<Out> => {
  const url = new URL('https://cnc.test/tr/api/tools/catalog');
  const request = new Request(url, opts.body === undefined ? { method: opts.method ?? 'GET' } : { method: opts.method ?? 'PUT', body: JSON.stringify(opts.body), headers: { 'Content-Type': 'application/json' } });
  return handler({ env: { DB, REGION: opts.region ?? 'tr' } as Ctx['env'], request, url, params: opts.params ?? {}, user }).then(
    async (r) => ({ status: r.status, data: await r.json() }),
    (e) => (e instanceof HttpError ? { status: e.status, data: e.message } : Promise.reject(e)),
  );
};
const features = (f: object) => DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('features', ?, 0)").bind(JSON.stringify(f)).run();
const toolRow = (id: string) => DB.prepare("SELECT number, category, description, diameter, length, materials FROM tools WHERE machine = 'HAAS-F' AND id = ?").bind(id).first();

// Made-up codes in the shop's form.
const SB = { code: 'SB_03.30_041_000_KS', diameter: 3.3, flutes: 2, materials: ['POM', 'PEEK'], description: '3.3mm Bohrer/41mm lang' };
const RA = { code: 'RA_09.00_051_000_KS', diameter: 9, flutes: 6, materials: ['POM'], description: '9 H7 Reibahle' };

describe("Türkiye's tool database", () => {
  it('is closed where the country has no tool database', () => {
    expect(featuresOfApiPath('/tools/catalog')).toEqual(['toolCatalog']);
    expect(featuresOfApiPath('/tools/HAAS-F/x')).toEqual([]);
  });

  it('starts empty, then an admin saves the list; the server reads each code itself', async () => {
    expect((await call(handleGetCatalog, ali)).data).toEqual({ tools: [], updatedAt: null, updatedBy: null });
    // What the code says (type, length, tool type) is the code's, whatever was sent.
    const saved = await call(handleSaveCatalog, admin, { body: { tools: [{ ...SB, type: 'XX', length: 999, category: 'taraud' }, RA] } });
    expect(saved.status).toBe(200);
    const got = (await call(handleGetCatalog, ali)).data;
    expect(got.updatedBy).toBe('sef');
    expect(got.tools).toEqual([
      { ...SB, type: 'SB', category: 'foret', length: 41, extra: '', materials: ['PEEK', 'POM'] },
      { ...RA, type: 'RA', category: 'alesoir', length: 51, extra: '' },
    ]);
  });

  it('refuses a list with a bad entry or no tool, and keeps the one it had', async () => {
    expect(await call(handleSaveCatalog, admin, { body: { tools: [SB, { ...RA, code: 'RA_9_51' }] } })).toEqual({ status: 400, data: 'The tool database has an entry that is not valid' });
    expect(await call(handleSaveCatalog, admin, { body: { tools: [SB, SB] } })).toMatchObject({ status: 400 });
    expect(await call(handleSaveCatalog, admin, { body: { tools: [] } })).toEqual({ status: 400, data: 'The tool database is empty' });
    expect((await call(handleGetCatalog, ali)).data.tools).toHaveLength(2);
  });
});

describe('a machinist adds a tool only from the database (A034)', () => {
  const put = (user: AuthedUser, id: string, body: object) => call(handlePutTool, user, { method: 'PUT', body, params: { machine: 'HAAS-F', id } });

  it('refuses a tool typed by hand, or a code the database does not have', async () => {
    expect(await put(ali, 't1', { number: 1, category: 'foret', description: 'MY DRILL', diameter: 3.3, length: 41 })).toEqual({ status: 403, data: 'Pick the tool from the tool database' });
    expect(await put(ali, 't1', { number: 1, code: 'SB_04.00_041_000_KS' })).toEqual({ status: 400, data: 'That tool is not in the tool database' });
    expect(await toolRow('t1')).toBeNull();
  });

  it("saves the database's tool in the slot asked for, whatever else was sent", async () => {
    expect((await put(ali, 't1', { number: 1, code: 'sb_03.30_041_000_ks', category: 'fraise', diameter: 99, description: 'x' })).status).toBe(200);
    expect(await toolRow('t1')).toEqual({ number: 1, category: 'foret', description: 'SB_03.30_041_000_KS', diameter: 3.3, length: 41, materials: '["PEEK","POM"]' });
  });

  it("keeps a new tool within the machine's slots; a tool already past them keeps its place", async () => {
    expect(await put(ali, 't2', { number: 42, code: RA.code })).toEqual({ status: 400, data: 'Slot 42 is past the last slot of this machine (41)' });
    await put(admin, 'old', { number: 55, category: 'foret', description: 'OLD', diameter: 5, length: 50 });
    expect((await put(ali, 'old', { number: 55, code: RA.code })).status).toBe(200);
    expect(await toolRow('old')).toMatchObject({ number: 55, category: 'alesoir' });
  });

  it('lets an admin type a tool the list lacks', async () => {
    expect((await put(admin, 't3', { number: 3, category: 'fraise', description: 'SPECIAL', diameter: 7, length: 40 })).status).toBe(200);
    expect(await toolRow('t3')).toMatchObject({ description: 'SPECIAL', diameter: 7 });
  });

  it("holds for the remapper's Add tool too", async () => {
    const batch = (user: AuthedUser, tools: object[]) => call(handleBatchTools, user, { method: 'POST', body: { tools }, params: { machine: 'HAAS-F' } });
    expect((await batch(ali, [{ id: 'b1', number: 5, pocket: 5, category: 'foret', description: 'TYPED', diameter: 3.3, length: 41 }])).status).toBe(403);
    expect((await batch(ali, [{ id: 'b1', number: 5, pocket: 5, code: SB.code }])).status).toBe(200);
    expect(await toolRow('b1')).toMatchObject({ number: 5, description: SB.code });
  });

  it('is not asked where the tool database is switched off', async () => {
    await features({ toolCatalog: false });
    expect((await put(ali, 't4', { number: 4, category: 'foret', description: 'TYPED', diameter: 4, length: 40 })).status).toBe(200);
    await features({ toolCatalog: true });
    expect((await put(ali, 't5', { number: 6, category: 'foret', description: 'TYPED', diameter: 4, length: 40 })).status).toBe(403);
  });
});
