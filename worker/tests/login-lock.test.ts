import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ensureSchema } from '../schema';
import { handleLogin, hashPassword } from '../auth';
import { HttpError } from '../http';
import { listRecipients, saveRecipient } from '../alerts';
import { handleDeleteMaster } from '../routes/master';
import type { Ctx, Env } from '../context';

// Password guesses: counted before the password is checked, per name and network, the same for
// real and unknown names. Deleted masters get no alerts.
let mf: Miniflare;
let DB: D1Database;
let hub: D1Database;

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-01-01', script: 'export default { fetch: () => new Response() }', d1Databases: ['DB', 'HUB'] }));
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  hub = (await mf.getD1Database('HUB')) as unknown as D1Database;
  await ensureSchema(DB, 'ma');
  await ensureSchema(hub, 'master');
  const hash = await hashPassword({ DB } as Env, 'Right-Password-1');
  await DB.prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u-chef', 'chef', ?, 'ADMIN', 0)").bind(hash).run();
  await hub.batch([
    hub.prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('m-1', 'boss', 'x', 'ADMIN', 0), ('m-2', 'gone', 'x', 'ADMIN', 0)"),
  ]);
}, 60_000);
afterAll(() => mf?.dispose());

const login = async (username: string, password: string, ip = '10.0.0.1') => {
  const url = new URL('https://cnc.test/api/auth/login');
  const request = new Request(url, { method: 'POST', body: JSON.stringify({ username, password }), headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip } });
  try {
    return (await handleLogin({ env: { DB, REGION: 'ma' } as Env, request, url, params: {}, user: null, waitUntil: () => undefined })).status;
  } catch (e) {
    if (e instanceof HttpError) return e.status;
    throw e;
  }
};

describe('sign-in limits', () => {
  it('parallel guesses cannot get past the limit', async () => {
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => login('chef', `wrong-${i}`)));
    expect(results.filter((s) => s === 401).length).toBeLessThanOrEqual(10);
    expect(results.filter((s) => s === 429).length).toBeGreaterThanOrEqual(15);
    // Locked even with the right password, from that network.
    expect(await login('chef', 'Right-Password-1')).toBe(429);
  });

  it('a stranger elsewhere does not lock the person out', async () => {
    expect(await login('chef', 'Right-Password-1', '10.9.9.9')).toBe(200);
  });

  it('an unknown name locks the same way, so the lock reveals no names', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push(await login('nobody-here', `wrong-${i}`));
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe('alerts after a master is deleted', () => {
  it('their linked chat and pending link are removed, and a leftover row is ignored', async () => {
    const rec = { username: '', chatId: 1, name: 'x', lang: 'en' as const, tgUsername: null, modes: {} as never, linkedAt: 0 };
    await saveRecipient(hub, { ...rec, userId: 'm-1', username: 'boss' });
    await saveRecipient(hub, { ...rec, userId: 'm-2', username: 'gone' });
    await hub.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('alerts:link:abc', ?, ?)").bind(JSON.stringify({ userId: 'm-2', username: 'gone', lang: 'en' }), Date.now()).run();
    const url = new URL('https://cnc.test/master/api/masters/m-2');
    const ctx = { env: { DB: hub, REGION: 'master' } as Env, request: new Request(url, { method: 'DELETE' }), url, params: { id: 'm-2' }, user: { id: 'm-1', username: 'boss', role: 'ADMIN' } } as Ctx;
    expect((await handleDeleteMaster(ctx)).status).toBe(200);
    expect((await listRecipients(hub)).map((r) => r.userId)).toEqual(['m-1']);
    expect(await hub.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'alerts:%' AND key != 'alerts:recipient:m-1'").first('n')).toBe(0);
    // A row left over from before this fix is not sent to either.
    await saveRecipient(hub, { ...rec, userId: 'm-old', username: 'old' });
    expect((await listRecipients(hub)).map((r) => r.userId)).toEqual(['m-1']);
  });
});
