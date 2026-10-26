import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ensureSchema } from '../schema';
import { HttpError } from '../http';
import type { AuthedUser, Ctx } from '../context';
import { handleCheckAction, handleCreateCheck, handleRequired, handleReportMissed } from '../routes/machines';

// Start / end of shift tasks on a real local D1 database, with the clock set by the test (Morocco, UTC+1).
let mf: Miniflare;
let DB: D1Database;
const admin: AuthedUser = { id: 'u-admin', username: 'chef', role: 'ADMIN' };
const ali: AuthedUser = { id: 'u-ali', username: 'ali', role: 'MACHINIST' }; // looks after HAAS-1
const youssef: AuthedUser = { id: 'u-youssef', username: 'youssef', role: 'MACHINIST' }; // no machine: may act on all
const at = (local: string) => vi.setSystemTime(new Date(`${local}+01:00`));

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-01-01', script: 'export default { fetch: () => new Response() }', d1Databases: ['DB'] }));
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  await ensureSchema(DB, 'ma');
  await DB.prepare("INSERT INTO machine_owners (machine_id, user_id, assigned_at) VALUES ('HAAS-1', 'u-ali', 0)").run();
}, 60_000);
afterAll(() => {
  vi.useRealTimers();
  return mf?.dispose();
});

function call(handler: (c: Ctx) => Promise<Response>, user: AuthedUser, params: Record<string, string>, body?: unknown, method = 'POST') {
  const url = new URL('https://cnc.test/api/x');
  const request = new Request(url, body === undefined ? { method } : { method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  return handler({ env: { DB, REGION: 'ma' } as Ctx['env'], request, url, params, user });
}
const status = (p: Promise<Response>) => p.then((r) => r.status, (e) => (e instanceof HttpError ? e.status : Promise.reject(e)));
const required = async (u: AuthedUser) =>
  (await (await call(handleRequired, u, {}, undefined, 'GET')).json()) as { locked: boolean; items: { id?: string }[]; ending: { id: string }[] };
const idOf = async (title: string) => (await DB.prepare('SELECT id FROM machine_checks WHERE title = ?').bind(title).first<{ id: string }>())!.id;

describe('start and end of shift tasks', () => {
  let start = '';
  let end = '';

  it('keeps every existing check when the table is rebuilt, and takes the two new kinds', async () => {
    expect((await DB.prepare('SELECT COUNT(*) AS n FROM machine_checks').first<{ n: number }>())!.n).toBe(88);
    expect(await status(call(handleCreateCheck, admin, { machine: 'HAAS-1' }, { title: 'Table cleaned, vise free', frequency: 'SHIFT_START' }))).toBe(200);
    expect(await status(call(handleCreateCheck, admin, { machine: 'HAAS-1' }, { title: 'Chips out, door closed', frequency: 'SHIFT_END' }))).toBe(200);
    expect(await status(call(handleCreateCheck, admin, { machine: 'HAAS-1' }, { title: 'x', frequency: 'HOURLY' }))).toBe(400);
    start = await idOf('Table cleaned, vise free');
    end = await idOf('Chips out, door closed');
  });

  it('start tasks lock at the start of the shift; end tasks only come in its last 45 minutes', async () => {
    at('2026-10-26T08:05:00');
    let r = await required(ali);
    expect(r.items.some((i) => i.id === start)).toBe(true);
    expect(r.items.some((i) => i.id === end)).toBe(false);
    expect(r.ending).toEqual([]);
    at('2026-10-26T15:14:00');
    expect((await required(ali)).ending).toEqual([]);
    at('2026-10-26T15:15:00');
    r = await required(ali);
    expect(r.ending.map((i) => i.id)).toEqual([end]);
    await call(handleCheckAction, ali, { machine: 'HAAS-1', id: end }, { action: 'DONE' });
    expect((await required(ali)).ending).toEqual([]);
  });

  it('the next shift reports a task the person before did not really do, once', async () => {
    at('2026-10-26T09:00:00'); // ali, morning shift: says the start task is done
    await call(handleCheckAction, ali, { machine: 'HAAS-1', id: start }, { action: 'DONE' });
    at('2026-10-26T17:00:00'); // next shift
    expect(await status(call(handleReportMissed, youssef, { machine: 'HAAS-1', id: start }))).toBe(200);
    expect(await status(call(handleReportMissed, youssef, { machine: 'HAAS-1', id: start }))).toBe(409);
    const ev = await DB.prepare("SELECT note, username FROM machine_events WHERE action = 'MISSED' AND check_id = ?").bind(start).all();
    expect(ev.results).toEqual([{ note: 'ali', username: 'youssef' }]);
  });

  it('names whoever worked on the machine when nobody confirmed the task, and refuses when nobody worked', async () => {
    at('2026-10-27T01:00:00'); // night shift: nobody on HAAS-1
    expect(await status(call(handleReportMissed, youssef, { machine: 'HAAS-1', id: start }))).toBe(409);
    at('2026-10-27T09:00:00'); // the night shift was empty too
    expect(await status(call(handleReportMissed, youssef, { machine: 'HAAS-1', id: end }))).toBe(409);
  });

  it('only start and end of shift tasks can be reported, and only on machines one may act on', async () => {
    at('2026-10-26T17:30:00');
    const daily = await idOf('Coolant level checked and topped up');
    expect(await status(call(handleReportMissed, youssef, { machine: 'HAAS-1', id: daily }))).toBe(400);
    const karim: AuthedUser = { id: 'u-karim', username: 'karim', role: 'MACHINIST' };
    await DB.prepare("INSERT INTO machine_owners (machine_id, user_id, assigned_at) VALUES ('FANUC-1', 'u-karim', 0)").run();
    expect(await status(call(handleReportMissed, karim, { machine: 'HAAS-1', id: end }))).toBe(403);
  });

  it('the end task was confirmed by ali in the morning shift: reporting it names ali', async () => {
    at('2026-10-26T17:45:00');
    expect(await status(call(handleReportMissed, youssef, { machine: 'HAAS-1', id: end }))).toBe(200);
    const ev = await DB.prepare("SELECT note FROM machine_events WHERE action = 'MISSED' AND check_id = ?").bind(end).first<{ note: string }>();
    expect(ev?.note).toBe('ali');
  });
});
