import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ensureSchema } from '../schema';
import { handlePrivateAsset } from '../assets';
import { sha256Hex } from '../security';
import type { Env } from '../context';
import type { RegionId } from '../../src/regions';

// The app's code (/app/...) only for signed-in sessions with the right access; the sign-in page stays public.
let mf: Miniflare;
let DB: D1Database;

// Static files: a real file is JavaScript, anything else falls back to the app's index.html.
const ASSETS = {
  fetch: async (input: RequestInfo) => {
    const path = new URL(typeof input === 'string' ? input : input.url).pathname;
    if (/^\/app\/[a-z]+\/real-[a-z]+\.js$/.test(path)) return new Response('export {}', { headers: { 'Content-Type': 'text/javascript' } });
    return new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } });
  },
} as unknown as Fetcher;

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-01-01', script: 'export default { fetch: () => new Response() }', d1Databases: ['DB'] }));
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  await ensureSchema(DB, 'ma');
  const far = 9999999999999;
  const now = Date.now();
  await DB.prepare(
    "INSERT INTO users (id, username, password_hash, role, created_at, toolpath_beta, cam_ai) VALUES ('u-admin', 'chef', 'x', 'ADMIN', 0, 0, 0), ('u-ali', 'ali', 'x', 'MACHINIST', 0, 0, 0), ('u-beta', 'beta', 'x', 'MACHINIST', 0, 1, 0), ('u-cam', 'cam', 'x', 'MACHINIST', 0, 0, 1)",
  ).run();
  for (const [token, user, role] of [
    ['tok-admin', 'u-admin', 'ADMIN'],
    ['tok-ali', 'u-ali', 'MACHINIST'],
    ['tok-beta', 'u-beta', 'MACHINIST'],
    ['tok-cam', 'u-cam', 'MACHINIST'],
  ]) {
    await DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, role) VALUES (?, ?, ?, ?, ?)')
      .bind(await sha256Hex(token), user, now, far, role)
      .run();
  }
}, 60_000);
afterAll(() => mf?.dispose());

const envFor = (instance: RegionId | 'master'): Env | null => (instance === 'ma' ? ({ DB, ASSETS, REGION: 'ma' } as Env) : null);

const get = async (path: string, token?: string, method = 'GET') => {
  const url = new URL(`https://cnc.test${path}`);
  const headers: Record<string, string> = token ? { Cookie: `__Host-cnc_sid=${token}` } : {};
  const res = await handlePrivateAsset(new Request(url, { method, headers }), { DB, ASSETS } as Env, url, envFor);
  return res.status;
};

describe('the app code is only for signed-in sessions', () => {
  it('nobody signed in gets nothing, whatever the access', async () => {
    for (const tier of ['user', 'admin', 'toolpath', 'cam', 'master', 'any']) expect(await get(`/app/${tier}/real-x.js`)).toBe(403);
    expect(await get('/app/user/real-x.js', 'not-a-session')).toBe(403);
  });

  it('a machinist gets the app, not the admin, toolpath, CAM AI or master files', async () => {
    expect(await get('/app/user/real-x.js', 'tok-ali')).toBe(200);
    expect(await get('/app/any/real-x.js', 'tok-ali')).toBe(200);
    expect(await get('/app/admin/real-x.js', 'tok-ali')).toBe(403);
    expect(await get('/app/toolpath/real-x.js', 'tok-ali')).toBe(403);
    expect(await get('/app/cam/real-x.js', 'tok-ali')).toBe(403);
    expect(await get('/app/master/real-x.js', 'tok-ali')).toBe(403);
  });

  it('the toolpath beta opens the viewer, CAM AI opens both, an admin opens all but the master files', async () => {
    expect(await get('/app/toolpath/real-x.js', 'tok-beta')).toBe(200);
    expect(await get('/app/cam/real-x.js', 'tok-beta')).toBe(403);
    expect(await get('/app/toolpath/real-x.js', 'tok-cam')).toBe(200);
    expect(await get('/app/cam/real-x.js', 'tok-cam')).toBe(200);
    for (const tier of ['user', 'admin', 'toolpath', 'cam', 'any']) expect(await get(`/app/${tier}/real-x.js`, 'tok-admin')).toBe(200);
    expect(await get('/app/master/real-x.js', 'tok-admin')).toBe(403);
  });

  it('the toolpath switched off in the country closes the toolpath and CAM AI files, even for an admin', async () => {
    await DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('features', ?, 0)").bind(JSON.stringify({ toolpath: false })).run();
    expect(await get('/app/cam/real-x.js', 'tok-admin')).toBe(403);
    expect(await get('/app/toolpath/real-x.js', 'tok-cam')).toBe(403);
    expect(await get('/app/user/real-x.js', 'tok-admin')).toBe(200);
    await DB.prepare("DELETE FROM settings WHERE key = 'features'").run();
  });

  it('a missing file, an odd path or a write is refused, never answered with the page', async () => {
    expect(await get('/app/user/missing-x.js', 'tok-admin')).toBe(404);
    expect(await get('/app/secret/real-x.js', 'tok-admin')).toBe(404);
    expect(await get('/app/user/sub/real-x.js', 'tok-admin')).toBe(404);
    expect(await get('/app/user/real-x.js', 'tok-admin', 'POST')).toBe(405);
  });

  it('is kept only by the browser', async () => {
    const url = new URL('https://cnc.test/app/user/real-x.js');
    const res = await handlePrivateAsset(new Request(url, { headers: { Cookie: '__Host-cnc_sid=tok-ali' } }), { DB, ASSETS } as Env, url, envFor);
    expect(res.headers.get('Cache-Control')).toMatch(/^private/);
    expect(res.headers.get('Vary')).toBe('Cookie');
  });
});
