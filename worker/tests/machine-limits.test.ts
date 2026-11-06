import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ensureSchema } from '../schema';
import { HttpError } from '../http';
import type { AuthedUser, Ctx } from '../context';
import { handleListFleet, handleUpdateMachine } from '../routes/fleet';

// CAM AI limits per machine: saved by an admin, empty by default, checked for sane values.
let mf: Miniflare;
let DB: D1Database;
const admin: AuthedUser = { id: 'u-admin', username: 'chef', role: 'ADMIN' };

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-01-01', script: 'export default { fetch: () => new Response() }', d1Databases: ['DB'] }));
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  await ensureSchema(DB, 'ma');
}, 60_000);
afterAll(() => mf?.dispose());

const ctx = (method: string, path: string, params: Record<string, string>, body?: unknown): Ctx => {
  const url = new URL(`https://cnc.test/api${path}`);
  const request = new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  return { env: { DB, REGION: 'ma' } as Ctx['env'], request, url, params, user: admin };
};
const patch = (body: unknown) =>
  handleUpdateMachine(ctx('PATCH', '/fleet/HAAS-1', { machine: 'HAAS-1' }, body)).then(
    (r) => r.status,
    (e) => (e instanceof HttpError ? e.status : Promise.reject(e)),
  );
const haas1 = async () => ((await (await handleListFleet(ctx('GET', '/fleet', {}))).json()) as { machines: Record<string, unknown>[] }).machines.find((m) => m.id === 'HAAS-1')!;

describe('machine limits for CAM AI', () => {
  it('are empty until an admin sets them, and keep the other fields', async () => {
    expect(await haas1()).toMatchObject({ maxRpm: null, maxFeed: null, rapid: null, toolChange: null });
    expect(await patch({ maxRpm: 12000, maxFeed: 10000, rapid: 25400, toolChange: 4.2 })).toBe(200);
    expect(await haas1()).toMatchObject({ name: 'HAAS-1', brand: 'HAAS', maxRpm: 12000, maxFeed: 10000, rapid: 25400, toolChange: 4.2 });
    expect(await patch({ maxRpm: null })).toBe(200);
    expect(await haas1()).toMatchObject({ maxRpm: null, maxFeed: 10000 });
  });

  it('turn down values no machine has', async () => {
    expect(await patch({ maxRpm: 5 })).toBe(400);
    expect(await patch({ maxFeed: 'fast' })).toBe(400);
    expect(await patch({ toolChange: 600 })).toBe(400);
    expect(await patch({ rapid: 12.5 })).toBe(400);
  });
});
