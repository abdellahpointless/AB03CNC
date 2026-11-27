import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ensureSchema } from '../schema';
import type { AuthedUser, Ctx } from '../context';
import { handleCheckAction, handleReportIssue } from '../routes/machines';

// "Stopped for" counts from when the machine was marked stopped, not from when the problem was reported.
let mf: Miniflare;
let DB: D1Database;
const admin: AuthedUser = { id: 'u-admin', username: 'chef', role: 'ADMIN' };

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-01-01', script: 'export default { fetch: () => new Response() }', d1Databases: ['DB'] }));
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  await ensureSchema(DB, 'ma');
}, 60_000);
afterAll(() => mf?.dispose());

async function call(handler: (c: Ctx) => Promise<Response>, params: Record<string, string>, body: unknown) {
  const url = new URL('https://cnc.test/api/x');
  const request = new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  return (await handler({ env: { DB, REGION: 'ma' } as Ctx['env'], request, url, params, user: admin })).json() as Promise<{ id?: string }>;
}
const row = (id: string) => DB.prepare('SELECT status_at, stopped_at, stops FROM machine_checks WHERE id = ?').bind(id).first<{ status_at: number; stopped_at: number | null; stops: number }>();
const stops = (id: string, on: boolean) => call(handleCheckAction, { machine: 'HAAS-1', id }, { action: 'STOPS', stops: on });

describe('machine stopped since', () => {
  it('is the report time for a problem that stops the machine from the start', async () => {
    const { id } = await call(handleReportIssue, { machine: 'HAAS-1' }, { note: 'Spindle noise', stops: true });
    const r = (await row(id!))!;
    expect(r.stopped_at).toBe(r.status_at);
  });

  it('is the time it was marked stopped, and is cleared when it runs again', async () => {
    const { id } = await call(handleReportIssue, { machine: 'HAAS-1' }, { note: 'Coolant leak' });
    const reported = Date.now() - 40 * 60_000;
    await DB.prepare('UPDATE machine_checks SET status_at = ? WHERE id = ?').bind(reported, id).run();
    expect((await row(id!))!.stopped_at).toBeNull();

    const before = Date.now();
    await stops(id!, true);
    let r = (await row(id!))!;
    expect(r.stops).toBe(1);
    expect(r.stopped_at).toBeGreaterThanOrEqual(before);
    expect(r.status_at).toBe(reported); // "reported N min ago" keeps the report time

    await stops(id!, false);
    expect((await row(id!))!.stopped_at).toBeNull();

    const again = Date.now();
    await stops(id!, true);
    r = (await row(id!))!;
    expect(r.stopped_at).toBeGreaterThanOrEqual(again);

    await call(handleCheckAction, { machine: 'HAAS-1', id: id! }, { action: 'RESOLVE' });
    expect(await row(id!)).toBeNull(); // a machine-level problem is deleted when resolved
  });
});
