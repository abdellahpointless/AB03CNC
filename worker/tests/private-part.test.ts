import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ensureSchema } from '../schema';
import { handleMe } from '../auth';
import { handleGetFeatures } from '../routes/fleet';
import { handleListUsers } from '../routes/users';
import type { AuthedUser, Ctx } from '../context';

// CAM AI exists only for Morocco's admins (and the master dashboard): nobody else's browser hears of it.
let mf: Miniflare;
let MA: D1Database;
let TR: D1Database;
const admin: AuthedUser = { id: 'u-admin', username: 'chef', role: 'ADMIN' };
const ali: AuthedUser = { id: 'u-ali', username: 'ali', role: 'MACHINIST', toolpathBeta: true };

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-01-01', script: 'export default { fetch: () => new Response() }', d1Databases: ['MA', 'TR'] }));
  MA = (await mf.getD1Database('MA')) as unknown as D1Database;
  TR = (await mf.getD1Database('TR')) as unknown as D1Database;
  await ensureSchema(MA, 'ma');
  await ensureSchema(TR, 'tr');
  // Ali still has the old per-person switch on in the database.
  await MA.prepare("INSERT INTO users (id, username, password_hash, role, created_at, cam_ai) VALUES ('u-admin', 'chef', 'x', 'ADMIN', 0, 0), ('u-ali', 'ali', 'x', 'MACHINIST', 0, 1)").run();
}, 60_000);
afterAll(() => mf?.dispose());

const call = async (handler: (ctx: Ctx) => Promise<Response>, user: AuthedUser, region: 'ma' | 'tr' = 'ma') => {
  const url = new URL('https://cnc.test/api/x');
  const res = await handler({ env: { DB: region === 'ma' ? MA : TR, REGION: region } as Ctx['env'], request: new Request(url), url, params: {}, user });
  return res.text();
};

describe('who hears of CAM AI', () => {
  it('the switches a browser gets: a neutral flag for Morocco\'s admins, nothing for anyone else', async () => {
    expect(JSON.parse(await call(handleGetFeatures, admin)).features.lab).toBe(true);
    for (const [user, region] of [[ali, 'ma'], [admin, 'tr']] as const) {
      const text = await call(handleGetFeatures, user, region);
      expect(JSON.parse(text).features.lab).toBeUndefined();
      expect(text).not.toMatch(/cam/i);
    }
    // Switched on for Türkiye by a master admin: still nothing there.
    await TR.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('features', ?, 0)").bind(JSON.stringify({ camAi: true })).run();
    expect(await call(handleGetFeatures, admin, 'tr')).not.toMatch(/cam|lab/i);
    // Switched off for Morocco: not even its admins.
    await MA.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('features', ?, 0)").bind(JSON.stringify({ camAi: false })).run();
    expect(JSON.parse(await call(handleGetFeatures, admin)).features.lab).toBeUndefined();
    await MA.prepare("DELETE FROM settings WHERE key = 'features'").run();
  });

  it('nobody\'s own record or the users list names it', async () => {
    expect(await call(handleMe, ali)).not.toMatch(/cam/i);
    expect(await call(handleMe, admin)).not.toMatch(/cam/i);
    expect(await call(handleListUsers, admin)).not.toMatch(/cam/i);
  });
});
