import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ensureSchema } from '../schema';
import { HttpError } from '../http';
import { handleGetTurnMemory, handleSaveTurnMemory } from '../routes/lessons';
import type { AuthedUser, Ctx, Env } from '../context';

// Turns learned from 3D models: kept in the master hub, so Morocco and Türkiye learn from each other.
let mf: Miniflare;
let MA: D1Database;
let TR: D1Database;
let HUB: D1Database;

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-01-01', script: 'export default { fetch: () => new Response() }', d1Databases: ['MA', 'TR', 'HUB'] }));
  MA = (await mf.getD1Database('MA')) as unknown as D1Database;
  TR = (await mf.getD1Database('TR')) as unknown as D1Database;
  HUB = (await mf.getD1Database('HUB')) as unknown as D1Database;
  await ensureSchema(MA, 'ma');
  await ensureSchema(TR, 'tr');
}, 60_000);
afterAll(() => mf?.dispose());

const ali: AuthedUser = { id: 'u-ali', username: 'ali', role: 'MACHINIST', toolpathBeta: true };
const plain: AuthedUser = { id: 'u-bob', username: 'bob', role: 'MACHINIST' };
const chef: AuthedUser = { id: 'u-chef', username: 'chef', role: 'ADMIN' };

const call = async (handler: (c: Ctx) => Promise<Response>, region: 'ma' | 'tr', user: AuthedUser, body?: unknown) => {
  const url = new URL('https://cnc.test/api/toolpath/memory');
  const request = body === undefined ? new Request(url) : new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  const env = { DB: region === 'ma' ? MA : TR, HUB, REGION: region } as Env;
  try {
    const res = await handler({ env, request, url, params: {}, user });
    return { status: res.status, body: (await res.json()) as { rows?: { key: string; rel: string; n: number }[] } };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: {} };
    throw e;
  }
};

const turn = '1,0,0,0,-1,0,0,0,-1';

describe('learned turns', () => {
  it('a turn learned in Morocco is read in Türkiye, counted each time', async () => {
    expect((await call(handleSaveTurnMemory, 'ma', ali, { entries: [{ key: 'TEIL N GRAD UM X DREHEN', rel: turn }] })).status).toBe(200);
    expect((await call(handleSaveTurnMemory, 'tr', chef, { entries: [{ key: 'TEIL N GRAD UM X DREHEN', rel: turn }] })).status).toBe(200);
    const rows = (await call(handleGetTurnMemory, 'tr', plain)).body.rows!;
    expect(rows).toEqual([{ key: 'TEIL N GRAD UM X DREHEN', rel: turn, n: 2 }]);
  });

  it('only people who may use the toolpath record; a record must be a turn', async () => {
    expect((await call(handleSaveTurnMemory, 'ma', plain, { entries: [{ key: 'K', rel: turn }] })).status).toBe(403);
    expect((await call(handleSaveTurnMemory, 'ma', ali, { entries: [{ key: 'K', rel: '2,0,0,0,1,0,0,0,1' }] })).status).toBe(400);
    expect((await call(handleSaveTurnMemory, 'ma', ali, { entries: [] })).status).toBe(400);
  });

  it('only an admin imports counts; a person adds one per check', async () => {
    await call(handleSaveTurnMemory, 'ma', ali, { entries: [{ key: 'IMPORTED', rel: turn, n: 50 }] });
    await call(handleSaveTurnMemory, 'ma', chef, { entries: [{ key: 'IMPORTED', rel: turn, n: 10 }] });
    const rows = (await call(handleGetTurnMemory, 'ma', plain)).body.rows!;
    expect(rows.find((r) => r.key === 'IMPORTED')!.n).toBe(11);
  });
});
