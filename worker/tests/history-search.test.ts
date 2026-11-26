import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ensureSchema } from '../schema';
import type { AuthedUser, Ctx } from '../context';
import { handleListHistory } from '../routes/history';

// History search: SQLite's LIKE ignores case for ASCII letters only, so Turkish capitals missed.
let mf: Miniflare;
let DB: D1Database;
const admin: AuthedUser = { id: 'u-admin', username: 'chef', role: 'ADMIN' };

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-01-01', script: 'export default { fetch: () => new Response() }', d1Databases: ['DB'] }));
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  await ensureSchema(DB, 'tr');
  const add = (id: string, username: string, machine: string, file: string) =>
    DB.prepare(
      `INSERT INTO history (id, created_at, date_label, username, machine, original_file_name, exported_file_name, changes)
       VALUES (?, 1, '-', ?, ?, ?, ?, '[]')`,
    ).bind(id, username, machine, file, file).run();
  await add('a', 'Çapak', 'HAAS-1', 'P100.NC');
  await add('b', 'KILAVUZ', 'DMG-İKİ', 'P200.NC');
  await add('c', 'ali', 'HAAS-2', 'p_100%.nc');
  await add('d', 'ali', 'HAAS-2', 'Program for the second vise.nc');
}, 60_000);
afterAll(() => mf?.dispose());

const search = async (q: string) => {
  const url = new URL(`https://cnc.test/api/history?q=${encodeURIComponent(q)}`);
  const res = await handleListHistory({ env: { DB, REGION: 'tr' } as Ctx['env'], request: new Request(url), url, params: {}, user: admin });
  return ((await res.json()) as { records: { id: string }[] }).records.map((r) => r.id).sort();
};

describe('history search', () => {
  it('ignores case for Turkish letters too', async () => {
    expect(await search('çapak')).toEqual(['a']);
    expect(await search('ÇAPAK')).toEqual(['a']);
    expect(await search('kılavuz')).toEqual(['b']);
    expect(await search('dmg-iki')).toEqual(['b']);
  });

  it('keeps ASCII case-blind and treats * ? [ % _ as plain text', async () => {
    expect(await search('haas')).toEqual(['a', 'c', 'd']);
    expect(await search('P_100%')).toEqual(['c']);
    expect(await search('*')).toEqual([]);
    expect(await search('[a]')).toEqual([]);
    expect(await search('p?00')).toEqual([]);
  });

  // D1 refuses LIKE and GLOB patterns over 50 bytes.
  it('takes a long query', async () => {
    expect(await search('PROGRAM FOR THE SECOND VISE')).toEqual(['d']);
    expect(await search('P100.NC from the first shift')).toEqual([]);
    expect(await search('x'.repeat(100))).toEqual([]);
    expect(await search('abcdefghjklm')).toEqual([]); // a GLOB of exactly 50 bytes
  });
});
