import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ensureSchema } from '../schema';
import type { AuthedUser, Ctx } from '../context';
import { handleMachinesReport } from '../routes/machines';
import { handleAnalytics, handleSetHiddenUsers } from '../routes/analytics';

// Preventive reports: only what went wrong in the period, and who confirms their checks the most.
// Test accounts the admin hid count nowhere.
let mf: Miniflare;
let DB: D1Database;
const admin: AuthedUser = { id: 'u-admin', username: 'chef', role: 'ADMIN' };
const T0 = Date.UTC(2026, 9, 1);

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-01-01', script: 'export default { fetch: () => new Response() }', d1Databases: ['DB'] }));
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  await ensureSchema(DB, 'ma');
  const ev = (action: string, at: number, note: string | null = null) =>
    DB.prepare("INSERT INTO machine_events (machine_id, check_id, check_title, action, note, username, at) VALUES ('HAAS-1', 'c1', 'Coolant', ?, ?, 'youssef', ?)").bind(action, note, at).run();
  await ev('PROBLEM', T0 + 1000, 'Pump noisy');
  await ev('MISSED', T0 + 2000, 'ali');
  await ev('DONE', T0 + 3000); // good news is not in the report
  await ev('MACHINE_DOWN', T0 - 1000); // before the period
  const done = (user: string, check: string, result: string, at: number) =>
    DB.prepare("INSERT INTO check_completions (check_id, machine_id, user_id, username, period_key, result, shift_key, at) VALUES (?, 'HAAS-1', ?, ?, 'p', ?, 's', ?)").bind(check, `u-${user}`, user, result, at).run();
  await done('ali', 'c1', 'OK', T0 + 10);
  await done('ali', 'c2', 'OK', T0 + 20);
  await done('karim', 'c1', 'PROBLEM', T0 + 30);
  await done('test', 'c1', 'OK', T0 + 40);
  await DB.prepare("INSERT INTO cales_checks (machine_id, user_id, shift_key, username, at) VALUES ('HAAS-1', 'u-ali', 's', 'ali', ?)").bind(T0 + 50).run();
  await DB.prepare("INSERT INTO extraction_stats (username, extractions, last_at) VALUES ('ali', 5, 0), ('test', 99, 0)").run();
}, 60_000);
afterAll(() => mf?.dispose());

const call = (handler: (c: Ctx) => Promise<Response>, qs = '', body?: unknown) => {
  const url = new URL(`https://cnc.test/api/x?${qs}`);
  const request = new Request(url, body === undefined ? {} : { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  return handler({ env: { DB, REGION: 'ma' } as Ctx['env'], request, url, params: {}, user: admin }).then((r) => r.json() as Promise<any>);
};

describe('preventive report', () => {
  it('lists only problems, stops and not-done reports inside the period', async () => {
    const r = await call(handleMachinesReport, `from=${T0}&to=${T0 + 86_400_000}`);
    expect(r.events.map((e: { action: string }) => e.action).sort()).toEqual(['MISSED', 'PROBLEM']);
    expect(r.truncated).toBe(false);
  });
  it('says so when there are more events than the list holds', async () => {
    const T1 = T0 + 30 * 86_400_000;
    await DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2001)
       INSERT INTO machine_events (machine_id, check_id, check_title, action, note, username, at) SELECT 'HAAS-2', 'c1', 'Coolant', 'PROBLEM', NULL, 'x', ? + i FROM n`,
    )
      .bind(T1)
      .run();
    const r = await call(handleMachinesReport, `from=${T1}&to=${T1 + 86_400_000}`);
    expect(r.events).toHaveLength(2000);
    expect(r.truncated).toBe(true);
  });
  it('counts checks and cales boxes confirmed per person, without hidden test accounts', async () => {
    await call(handleSetHiddenUsers, '', { usernames: ['TEST'] });
    const r = await call(handleMachinesReport, `from=${T0}&to=${T0 + 86_400_000}`);
    expect(r.people).toEqual([
      { username: 'ali', done: 3, problems: 0 },
      { username: 'karim', done: 0, problems: 1 },
    ]);
    const a = await call(handleAnalytics);
    expect(a.totalExtractions).toBe(5);
    expect(a.users.find((u: { username: string }) => u.username === 'test').hidden).toBe(true);
  });
});
