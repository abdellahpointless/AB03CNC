import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ensureSchema } from '../schema';
import { HttpError } from '../http';
import type { AuthedUser, Ctx } from '../context';
import { handleCalesConfirm, handleCalesDecide, handleCalesReport, handleCalesRequest, handleCalesSetOnMachine, handleCalesSetStock } from '../routes/cales';
import { handleCheckAction, handleListMachines, handleRequired } from '../routes/machines';

// A real (local) D1 database: approvals must be all-or-nothing, so this is tested on SQLite itself.
let mf: Miniflare;
let DB: D1Database;
const admin: AuthedUser = { id: 'u-admin', username: 'chef', role: 'ADMIN' };
const ali: AuthedUser = { id: 'u-ali', username: 'ali', role: 'MACHINIST' }; // looks after HAAS-1
const karim: AuthedUser = { id: 'u-karim', username: 'karim', role: 'MACHINIST' }; // looks after FANUC-1
const youssef: AuthedUser = { id: 'u-youssef', username: 'youssef', role: 'MACHINIST' }; // no machine

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-01-01', script: 'export default { fetch: () => new Response() }', d1Databases: ['DB'] }));
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  await ensureSchema(DB, 'ma');
  await DB.batch([
    DB.prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u-ali', 'ali', 'x', 'MACHINIST', 0), ('u-karim', 'karim', 'x', 'MACHINIST', 0)"),
    DB.prepare("INSERT INTO machine_owners (machine_id, user_id, assigned_at) VALUES ('HAAS-1', 'u-ali', 0), ('FANUC-1', 'u-karim', 0)"),
  ]);
}, 60_000);
afterAll(() => mf?.dispose());

function call(handler: (c: Ctx) => Promise<Response>, user: AuthedUser, params: Record<string, string>, body?: unknown, method = 'POST') {
  const url = new URL('https://cnc.test/api/x');
  const request = new Request(url, body === undefined ? { method } : { method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  return handler({ env: { DB, REGION: 'ma' } as Ctx['env'], request, url, params, user });
}
const status = (p: Promise<Response>) =>
  p.then(
    (r) => r.status,
    (e) => (e instanceof HttpError ? e.status : Promise.reject(e)),
  );
const stockOf = async (m: string, h: number) => (await DB.prepare('SELECT qty FROM cales_stock WHERE machine_id = ? AND height = ?').bind(m, h).first<{ qty: number }>())?.qty;
const stateOf = (m: string, h: number) => DB.prepare('SELECT status, count FROM cales_state WHERE machine_id = ? AND height = ?').bind(m, h).first();
const openRequest = (m: string, h: number) => DB.prepare("SELECT id FROM cales_requests WHERE machine_id = ? AND height = ? AND status = 'OPEN'").bind(m, h).first<{ id: string }>();

describe('cales reports', () => {
  it('only accepts real heights, kinds and counts', async () => {
    expect(await status(call(handleCalesReport, ali, { machine: 'HAAS-1' }, { height: 9, kind: 'MISSING', count: 1 }))).toBe(400);
    expect(await status(call(handleCalesReport, ali, { machine: 'HAAS-1' }, { height: 30, kind: 'LOST', count: 1 }))).toBe(400);
    expect(await status(call(handleCalesReport, ali, { machine: 'HAAS-1' }, { height: 30, kind: 'MISSING', count: 3 }))).toBe(400);
  });

  it('only lets people report on the machines they look after', async () => {
    expect(await status(call(handleCalesReport, karim, { machine: 'HAAS-1' }, { height: 30, kind: 'MISSING', count: 1 }))).toBe(403);
    expect(await status(call(handleCalesReport, ali, { machine: 'HAAS-1' }, { height: 43, kind: 'DAMAGED', count: 1 }))).toBe(200);
    expect(await stateOf('HAAS-1', 43)).toEqual({ status: 'DAMAGED', count: 1 });
  });

  it('a found pair is back; a damaged one stays damaged until replaced', async () => {
    await call(handleCalesReport, ali, { machine: 'HAAS-1' }, { height: 42, kind: 'MISSING', count: 2 });
    expect(await status(call(handleCalesReport, ali, { machine: 'HAAS-1' }, { height: 42, kind: 'FOUND' }))).toBe(200);
    expect(await stateOf('HAAS-1', 42)).toBeNull();
    expect(await status(call(handleCalesReport, ali, { machine: 'HAAS-1' }, { height: 43, kind: 'FOUND' }))).toBe(409);
  });
});

describe('new cales: requests and approval', () => {
  it('one open request per pair', async () => {
    await call(handleCalesReport, ali, { machine: 'HAAS-1' }, { height: 30, kind: 'MISSING', count: 2 });
    expect(await status(call(handleCalesRequest, ali, { machine: 'HAAS-1' }, { height: 30 }))).toBe(200);
    expect(await status(call(handleCalesRequest, ali, { machine: 'HAAS-1' }, { height: 30 }))).toBe(409);
    expect(await status(call(handleCalesRequest, ali, { machine: 'HAAS-1' }, { height: 8 }))).toBe(409); // pair in its place
  });

  it('is blocked when the stock is short, and then changes nothing', async () => {
    await call(handleCalesSetStock, admin, { machine: 'HAAS-1', height: '30' }, { qty: 1 }, 'PUT');
    const req = await openRequest('HAAS-1', 30);
    expect(await status(call(handleCalesDecide, admin, { id: req!.id }, { decision: 'APPROVE' }))).toBe(409);
    expect(await stockOf('HAAS-1', 30)).toBe(1);
    expect(await stateOf('HAAS-1', 30)).toEqual({ status: 'MISSING', count: 2 });
  });

  it('takes the cales from stock, puts the pair back and logs it, once', async () => {
    await call(handleCalesSetStock, admin, { machine: 'HAAS-1', height: '30' }, { qty: 5 }, 'PUT');
    const req = await openRequest('HAAS-1', 30);
    expect(await status(call(handleCalesDecide, admin, { id: req!.id }, { decision: 'APPROVE' }))).toBe(200);
    expect(await stockOf('HAAS-1', 30)).toBe(3);
    expect(await stateOf('HAAS-1', 30)).toBeNull();
    const ev = await DB.prepare("SELECT count, username FROM cales_events WHERE machine_id = 'HAAS-1' AND height = 30 AND kind = 'REPLACED'").all();
    expect(ev.results).toEqual([{ count: 2, username: 'chef' }]);
    expect(await status(call(handleCalesDecide, admin, { id: req!.id }, { decision: 'APPROVE' }))).toBe(409);
    expect(await stockOf('HAAS-1', 30)).toBe(3);
  });

  it('does nothing if the pair turned up again before the approval', async () => {
    await call(handleCalesSetStock, admin, { machine: 'HAAS-1', height: '25' }, { qty: 4 }, 'PUT');
    await call(handleCalesReport, ali, { machine: 'HAAS-1' }, { height: 25, kind: 'MISSING', count: 1 });
    await call(handleCalesRequest, ali, { machine: 'HAAS-1' }, { height: 25 });
    const req = await openRequest('HAAS-1', 25);
    await call(handleCalesReport, ali, { machine: 'HAAS-1' }, { height: 25, kind: 'FOUND' });
    expect(await status(call(handleCalesDecide, admin, { id: req!.id }, { decision: 'APPROVE' }))).toBe(409);
    expect(await stockOf('HAAS-1', 25)).toBe(4);
    // finding it again already closed the request: nothing is left for the admin to reject
    expect(await openRequest('HAAS-1', 25)).toBeNull();
    expect(await status(call(handleCalesDecide, admin, { id: req!.id }, { decision: 'REJECT' }))).toBe(409);
  });

  it('closes the open request when the pair is back, so the next loss can be requested again', async () => {
    await call(handleCalesReport, ali, { machine: 'HAAS-1' }, { height: 25, kind: 'MISSING', count: 1 });
    await call(handleCalesRequest, ali, { machine: 'HAAS-1' }, { height: 25 });
    await call(handleCalesReport, ali, { machine: 'HAAS-1' }, { height: 25, kind: 'FOUND' });
    expect(await openRequest('HAAS-1', 25)).toBeNull();
    await call(handleCalesReport, ali, { machine: 'HAAS-1' }, { height: 25, kind: 'MISSING', count: 2 });
    expect(await status(call(handleCalesRequest, ali, { machine: 'HAAS-1' }, { height: 25 }))).toBe(200);
    // the admin putting the pair back in the "On machine" table closes it too
    await call(handleCalesSetOnMachine, admin, { machine: 'HAAS-1', height: '25' }, { present: 2 }, 'PUT');
    expect(await openRequest('HAAS-1', 25)).toBeNull();
  });

  it('never lets the stock go below zero', async () => {
    await expect(DB.prepare("UPDATE cales_stock SET qty = qty - 10 WHERE machine_id = 'HAAS-1' AND height = 25").run()).rejects.toThrow(/CHECK/);
    expect(await status(call(handleCalesSetStock, admin, { machine: 'HAAS-1', height: '25' }, { qty: -1 }, 'PUT'))).toBe(400);
  });
});

describe('the machine list', () => {
  const machinesOf = async (u: AuthedUser) => {
    const body = (await (await call(handleListMachines, u, {}, undefined, 'GET')).json()) as { checks: { machine_id: string }[]; events: { machine_id: string }[] };
    return [...new Set([...body.checks, ...body.events].map((r) => r.machine_id))];
  };
  it('sends a responsible user only the machines they look after', async () => {
    expect(await machinesOf(ali)).toEqual(['HAAS-1']);
    expect((await machinesOf(admin)).length).toBeGreaterThan(1);
    expect((await machinesOf(youssef)).length).toBeGreaterThan(1); // no machine: sees all, like before
  });
});

describe('what a user must do first', () => {
  const required = async (u: AuthedUser) => (await (await call(handleRequired, u, {}, undefined, 'GET')).json()) as { locked: boolean; items: { kind: string; id?: string; machineId: string }[] };

  it('admins and people with no machine are never locked', async () => {
    expect((await required(admin)).locked).toBe(false);
    expect((await required(youssef)).locked).toBe(false);
  });

  it('each person does the checks and the cales box of their own machines themselves', async () => {
    const first = await required(ali);
    expect(first.locked).toBe(true);
    expect(first.items.every((i) => i.machineId === 'HAAS-1')).toBe(true);
    const checks = first.items.filter((i) => i.kind === 'CHECK');
    expect(checks.length).toBe(11);
    expect(first.items.filter((i) => i.kind === 'CALES')).toHaveLength(1);

    // Someone else doing a check does not count for ali.
    expect(await status(call(handleCheckAction, youssef, { machine: 'HAAS-1', id: checks[0].id! }, { action: 'DONE' }))).toBe(200);
    expect((await required(ali)).items.filter((i) => i.kind === 'CHECK')).toHaveLength(11);

    // A reported problem counts as done.
    await call(handleCheckAction, ali, { machine: 'HAAS-1', id: checks[0].id! }, { action: 'PROBLEM', note: 'Coolant low' });
    for (const c of checks.slice(1)) await call(handleCheckAction, ali, { machine: 'HAAS-1', id: c.id! }, { action: 'DONE' });
    expect((await required(ali)).items.map((i) => i.kind)).toEqual(['CALES']);

    await call(handleCalesConfirm, ali, { machine: 'HAAS-1' });
    expect(await required(ali)).toMatchObject({ locked: false, items: [] });

    const list = (await (await call(handleListMachines, ali, {}, undefined, 'GET')).json()) as { myDone: string[]; calesChecked: string[] };
    expect(list.myDone).toHaveLength(11);
    expect(list.calesChecked).toEqual(['HAAS-1']);
  });
});

describe('what is really on the machine (admin)', () => {
  it('a machine with no cales shows them missing; a request, once approved, fills the box from the stock', async () => {
    expect(await status(call(handleCalesSetOnMachine, admin, { machine: 'FANUC-1', height: '30' }, { present: 3 }, 'PUT'))).toBe(400);
    expect(await status(call(handleCalesSetOnMachine, karim, { machine: 'FANUC-1', height: '30' }, { present: 0 }, 'PUT'))).toBe(200); // route is admin-only; the handler trusts it
    await call(handleCalesSetOnMachine, admin, { machine: 'FANUC-1', height: '30' }, { present: 0 }, 'PUT');
    expect(await stateOf('FANUC-1', 30)).toEqual({ status: 'MISSING', count: 2 });
    await call(handleCalesRequest, karim, { machine: 'FANUC-1' }, { height: 30 });
    await call(handleCalesSetStock, admin, { machine: 'FANUC-1', height: '30' }, { qty: 4 }, 'PUT');
    const req = await openRequest('FANUC-1', 30);
    expect(await status(call(handleCalesDecide, admin, { id: req!.id }, { decision: 'APPROVE' }))).toBe(200);
    expect(await stateOf('FANUC-1', 30)).toBeNull();
    expect(await stockOf('FANUC-1', 30)).toBe(2);
  });
  it('one cale left: one missing; back to two: found again', async () => {
    await call(handleCalesSetOnMachine, admin, { machine: 'FANUC-1', height: '30' }, { present: 1 }, 'PUT');
    expect(await stateOf('FANUC-1', 30)).toEqual({ status: 'MISSING', count: 1 });
    await call(handleCalesSetOnMachine, admin, { machine: 'FANUC-1', height: '30' }, { present: 2 }, 'PUT');
    expect(await stateOf('FANUC-1', 30)).toBeNull();
    const last = await DB.prepare("SELECT kind, count FROM cales_events WHERE machine_id = 'FANUC-1' AND height = 30 ORDER BY id DESC LIMIT 1").first();
    expect(last).toEqual({ kind: 'FOUND', count: 1 });
  });
});
