import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ensureSchema } from '../schema';
import { HttpError } from '../http';
import type { AuthedUser, Ctx } from '../context';
import { handleAdminExport, handleAdminProduction } from '../routes/parts';

// Part review: a 26th-to-26th period filters on the entry time; the end day is not counted.
let mf: Miniflare;
let DB: D1Database;
const admin: AuthedUser = { id: 'u-admin', username: 'chef', role: 'ADMIN' };

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-01-01', script: 'export default { fetch: () => new Response() }', d1Databases: ['DB'] }));
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  await ensureSchema(DB, 'ma');
  const add = (id: string, at: string) =>
    DB.prepare(
      `INSERT INTO part_entries (id, user_id, username, sap_number, qty, kind, unit_value, status, month_key, created_at)
       VALUES (?, 'u-ali', 'ali', 'P1', 1, 'PRODUCED', 1, 'APPROVED', '2026-10', ?)`,
    ).bind(id, at).run();
  await add('before', '2026-09-25T22:59:59.000Z'); // 25 Sep 23:59 in Morocco (UTC+1)
  await add('first', '2026-09-25T23:00:00.000Z'); // 26 Sep 00:00 in Morocco
  await add('imported', '2026-10-10 08:00:00'); // an Excel-imported date without the ISO "T"
  await add('last', '2026-10-25T22:59:00.000Z');
  await add('end', '2026-10-25T23:00:00.000Z'); // 26 Oct 00:00: the next period
}, 60_000);
afterAll(() => mf?.dispose());

const call = (handler: (c: Ctx) => Promise<Response>, qs: string) => {
  const url = new URL(`https://cnc.test/api/x?${qs}`);
  return handler({ env: { DB, REGION: 'ma' } as Ctx['env'], request: new Request(url), url, params: {}, user: admin });
};
const from = Date.parse('2026-09-25T23:00:00.000Z');
const to = Date.parse('2026-10-25T23:00:00.000Z');

describe('part review period', () => {
  it('counts the 26th and excludes the next 26th', async () => {
    const rows = ((await (await call(handleAdminProduction, `from=${from}&to=${to}`)).json()) as { rows: { produced_qty: number }[] }).rows;
    expect(rows[0].produced_qty).toBe(3);
    const ids = ((await (await call(handleAdminExport, `from=${from}&to=${to}&offset=0`)).json()) as { entries: { id: string }[] }).entries.map((e) => e.id);
    expect(ids.sort()).toEqual(['first', 'imported', 'last']);
  });
  it('refuses a backwards or a year-long range', async () => {
    const status = (p: Promise<Response>) => p.then((r) => r.status, (e) => (e instanceof HttpError ? e.status : 0));
    expect(await status(call(handleAdminProduction, `from=${to}&to=${from}`))).toBe(400);
    expect(await status(call(handleAdminProduction, `from=0&to=${to}`))).toBe(400);
  });
});
