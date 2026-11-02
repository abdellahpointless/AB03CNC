import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ensureSchema } from '../schema';
import { HttpError } from '../http';
import type { AuthedUser, Ctx } from '../context';
import { handleUpdateUser } from '../routes/users';

// Toolpath beta access per person: set by an admin, without signing the person out.
let mf: Miniflare;
let DB: D1Database;
const admin: AuthedUser = { id: 'u-admin', username: 'chef', role: 'ADMIN' };

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-01-01', script: 'export default { fetch: () => new Response() }', d1Databases: ['DB'] }));
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  await ensureSchema(DB, 'ma');
  await DB.batch([
    DB.prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u-admin', 'chef', 'x', 'ADMIN', 0), ('u-ali', 'ali', 'x', 'MACHINIST', 0)"),
    DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, role) VALUES ('t-ali', 'u-ali', 0, 9999999999999, 'MACHINIST')"),
  ]);
}, 60_000);
afterAll(() => mf?.dispose());

const patch = (id: string, body: unknown) => {
  const url = new URL(`https://cnc.test/api/users/${id}`);
  const request = new Request(url, { method: 'PATCH', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  return handleUpdateUser({ env: { DB, REGION: 'ma' } as Ctx['env'], request, url, params: { id }, user: admin }).then(
    (r) => r.status,
    (e) => (e instanceof HttpError ? e.status : Promise.reject(e)),
  );
};
const beta = async () => (await DB.prepare("SELECT toolpath_beta FROM users WHERE id = 'u-ali'").first<{ toolpath_beta: number }>())!.toolpath_beta;

describe('toolpath beta access', () => {
  it('starts off, is switched on and off by an admin, and keeps the person signed in', async () => {
    expect(await beta()).toBe(0);
    expect(await patch('u-ali', { toolpathBeta: true })).toBe(200);
    expect(await beta()).toBe(1);
    expect(await DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = 'u-ali'").first('n')).toBe(1);
    expect(await patch('u-ali', { toolpathBeta: false })).toBe(200);
    expect(await beta()).toBe(0);
  });

  it('takes only true or false, and not mixed with other changes', async () => {
    expect(await patch('u-ali', { toolpathBeta: 'yes' })).toBe(400);
    expect(await patch('u-ali', { toolpathBeta: true, role: 'ADMIN' })).toBe(400);
    expect(await patch('u-nobody', { toolpathBeta: true })).toBe(404);
  });
});
