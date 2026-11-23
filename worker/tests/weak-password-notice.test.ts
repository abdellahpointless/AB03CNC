import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ensureSchema } from '../schema';
import { handleLogin, hashPassword } from '../auth';
import type { Env } from '../context';

// The weak-password reminder is a soft notice: shown at one sign-in per user, then never again.
let mf: Miniflare;
let DB: D1Database;

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-01-01', script: 'export default { fetch: () => new Response() }', d1Databases: ['DB'] }));
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  await ensureSchema(DB, 'ma');
  const hash = await hashPassword({ DB } as Env, 'password');
  await DB.prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u-op', 'operator', ?, 'MACHINIST', 0)").bind(hash).run();
}, 60_000);
afterAll(() => mf?.dispose());

const login = async () => {
  const url = new URL('https://cnc.test/api/auth/login');
  const request = new Request(url, { method: 'POST', body: JSON.stringify({ username: 'operator', password: 'password' }), headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.2' } });
  const res = await handleLogin({ env: { DB, REGION: 'ma' } as Env, request, url, params: {}, user: null, waitUntil: () => undefined });
  return (await res.json()) as { weakPassword?: boolean };
};

describe('weak-password reminder', () => {
  it('is shown at the first sign-in with a weak password and not at the next ones', async () => {
    expect((await login()).weakPassword).toBe(true);
    expect((await login()).weakPassword).toBe(false);
    expect((await login()).weakPassword).toBe(false);
  });
});
