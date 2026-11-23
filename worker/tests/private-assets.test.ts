import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ensureSchema } from '../schema';
import { handlePrivateAsset } from '../assets';
import { handleSetCountryFeatures } from '../routes/master';
import { sha256Hex } from '../security';
import type { Ctx, Env } from '../context';
import type { RegionId } from '../../src/regions';

// The app's code (/app/...) only for signed-in sessions with the right access; the sign-in page stays public.
let mf: Miniflare;
let DB: D1Database;
let TR: D1Database;
let HUB: D1Database;

// Static files: a real file is JavaScript, anything else falls back to the app's index.html.
const ASSETS = {
  fetch: async (input: RequestInfo) => {
    const path = new URL(typeof input === 'string' ? input : input.url).pathname;
    if (/^\/app\/[a-z]+\/(real-[a-z]+|step\.worker-[A-Za-z0-9]+)\.js$/.test(path)) return new Response('export {}', { headers: { 'Content-Type': 'text/javascript', 'Content-Security-Policy': "script-src 'self'" } });
    if (/^\/app\/[a-z]+\/real-[a-z]+\.wasm$/.test(path)) return new Response(new Uint8Array([0, 97, 115, 109]), { headers: { 'Content-Type': 'application/wasm' } });
    return new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } });
  },
} as unknown as Fetcher;

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-01-01', script: 'export default { fetch: () => new Response() }', d1Databases: ['DB', 'TR', 'HUB'] }));
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  TR = (await mf.getD1Database('TR')) as unknown as D1Database;
  HUB = (await mf.getD1Database('HUB')) as unknown as D1Database;
  await ensureSchema(DB, 'ma');
  await ensureSchema(TR, 'tr');
  await ensureSchema(HUB, 'master');
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
  // Türkiye: an admin and a person with the CAM AI switch (set before the feature was closed).
  await TR.prepare("INSERT INTO users (id, username, password_hash, role, created_at, toolpath_beta, cam_ai) VALUES ('t-admin', 'sef', 'x', 'ADMIN', 0, 0, 0), ('t-cam', 'cam', 'x', 'MACHINIST', 0, 0, 1)").run();
  for (const [token, user, role] of [
    ['tr-admin', 't-admin', 'ADMIN'],
    ['tr-cam', 't-cam', 'MACHINIST'],
  ]) {
    await TR.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, role) VALUES (?, ?, ?, ?, ?)')
      .bind(await sha256Hex(token), user, now, far, role)
      .run();
  }
}, 60_000);
afterAll(() => mf?.dispose());

const envFor = (instance: RegionId | 'master'): Env | null =>
  instance === 'ma' ? ({ DB, ASSETS, REGION: 'ma' } as Env) : instance === 'tr' ? ({ DB: TR, ASSETS, REGION: 'tr' } as Env) : null;

const get = async (path: string, token?: string, method = 'GET') => {
  const url = new URL(`https://cnc.test${path}`);
  const cookie = token?.startsWith('tr-') ? '__Host-cnc_sid_tr' : '__Host-cnc_sid';
  const headers: Record<string, string> = token ? { Cookie: `${cookie}=${token}` } : {};
  const res = await handlePrivateAsset(new Request(url, { method, headers }), { DB, ASSETS } as Env, url, envFor);
  return res.status;
};

describe('the app code is only for signed-in sessions', () => {
  it('nobody signed in gets nothing, whatever the access', async () => {
    for (const tier of ['user', 'admin', 'toolpath', 'p', 'master', 'any']) expect(await get(`/app/${tier}/real-x.js`)).toBe(403);
    expect(await get('/app/user/real-x.js', 'not-a-session')).toBe(403);
  });

  it('a machinist gets the app, not the admin, toolpath, private (p) or master files', async () => {
    expect(await get('/app/user/real-x.js', 'tok-ali')).toBe(200);
    expect(await get('/app/any/real-x.js', 'tok-ali')).toBe(200);
    expect(await get('/app/admin/real-x.js', 'tok-ali')).toBe(403);
    expect(await get('/app/toolpath/real-x.js', 'tok-ali')).toBe(403);
    expect(await get('/app/p/real-x.js', 'tok-ali')).toBe(403);
    expect(await get('/app/master/real-x.js', 'tok-ali')).toBe(403);
  });

  it('only the STEP reader\'s own worker may build code at run time; the rest of the app stays strict', async () => {
    const csp = async (path: string) => {
      const url = new URL(`https://cnc.test${path}`);
      const res = await handlePrivateAsset(new Request(url, { headers: { Cookie: `__Host-cnc_sid=tok-beta` } }), { DB, ASSETS } as Env, url, envFor);
      return res.headers.get('Content-Security-Policy') ?? '';
    };
    expect(await csp('/app/toolpath/step.worker-Ab12.js')).toMatch(/script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'/);
    expect(await csp('/app/toolpath/real-x.js')).not.toMatch(/unsafe-eval/);
  });

  it('the STEP reader (WebAssembly) goes to toolpath users and Morocco\'s admins only', async () => {
    expect(await get('/app/toolpath/real-x.wasm')).toBe(403);
    expect(await get('/app/toolpath/real-x.wasm', 'tok-ali')).toBe(403);
    expect(await get('/app/toolpath/real-x.wasm', 'tok-beta')).toBe(200);
    expect(await get('/app/toolpath/real-x.wasm', 'tok-admin')).toBe(200);
    // The old per-person switch gives nothing any more.
    expect(await get('/app/toolpath/real-x.wasm', 'tok-cam')).toBe(403);
  });

  it('the private files (p) are for Morocco\'s admins only; the toolpath beta opens the viewer; nobody else either', async () => {
    expect(await get('/app/toolpath/real-x.js', 'tok-beta')).toBe(200);
    expect(await get('/app/p/real-x.js', 'tok-beta')).toBe(403);
    // A machinist with the old per-person switch on: nothing.
    expect(await get('/app/toolpath/real-x.js', 'tok-cam')).toBe(403);
    expect(await get('/app/p/real-x.js', 'tok-cam')).toBe(403);
    for (const tier of ['user', 'admin', 'toolpath', 'p', 'any']) expect(await get(`/app/${tier}/real-x.js`, 'tok-admin')).toBe(200);
    expect(await get('/app/master/real-x.js', 'tok-admin')).toBe(403);
  });

  it('each country switch closes its own files, even for an admin; CAM AI keeps the viewer it uses', async () => {
    const set = (f: object) => DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('features', ?, 0)").bind(JSON.stringify(f)).run();
    // Toolpath off, the private part on (the default): it and its viewer stay for the admin, the beta viewer closes.
    await set({ toolpath: false });
    expect(await get('/app/p/real-x.js', 'tok-admin')).toBe(200);
    expect(await get('/app/toolpath/real-x.js', 'tok-admin')).toBe(200);
    expect(await get('/app/toolpath/real-x.js', 'tok-beta')).toBe(403);
    // The private part off, toolpath on: its files close, the viewer stays.
    await set({ camAi: false });
    expect(await get('/app/p/real-x.js', 'tok-admin')).toBe(403);
    expect(await get('/app/toolpath/real-x.js', 'tok-beta')).toBe(200);
    expect(await get('/app/toolpath/real-x.js', 'tok-admin')).toBe(200);
    // Both off: neither, for anyone.
    await set({ toolpath: false, camAi: false });
    expect(await get('/app/p/real-x.js', 'tok-admin')).toBe(403);
    expect(await get('/app/toolpath/real-x.js', 'tok-admin')).toBe(403);
    expect(await get('/app/toolpath/real-x.js', 'tok-beta')).toBe(403);
    expect(await get('/app/user/real-x.js', 'tok-admin')).toBe(200);
    await DB.prepare("DELETE FROM settings WHERE key = 'features'").run();
  });

  it('Türkiye never gets the private part, even with its switch on', async () => {
    expect(await get('/app/admin/real-x.js', 'tr-admin')).toBe(200);
    expect(await get('/app/p/real-x.js', 'tr-admin')).toBe(403);
    expect(await get('/app/p/real-x.js', 'tr-cam')).toBe(403);
    expect(await get('/app/toolpath/real-x.js', 'tr-admin')).toBe(403);
    const url = new URL('https://cnc.test/master/api/countries/tr/features');
    const request = new Request(url, { method: 'PUT', body: JSON.stringify({ camAi: true }), headers: { 'Content-Type': 'application/json' } });
    const env = { DB: HUB, COUNTRIES: { tr: TR }, REGION: 'master' } as unknown as Env;
    const res = await handleSetCountryFeatures({ env, request, url, params: { region: 'tr' }, user: { id: 'm-1', username: 'boss', role: 'ADMIN' } } as Ctx);
    expect(((await res.json()) as { features: { camAi: boolean } }).features.camAi).toBe(true);
    expect(await get('/app/p/real-x.js', 'tr-admin')).toBe(403);
    expect(await get('/app/p/real-x.js', 'tr-cam')).toBe(403);
    expect(await get('/app/toolpath/real-x.js', 'tr-cam')).toBe(403);
    // Morocco is not affected by Türkiye's switch.
    expect(await get('/app/p/real-x.js', 'tok-admin')).toBe(200);
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
