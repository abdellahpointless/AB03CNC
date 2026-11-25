import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ensureSchema } from '../schema';
import { HttpError } from '../http';
import type { AuthedUser, Ctx } from '../context';
import { handleListLabTools, handleResetLabTool, handleSaveLabTool, MAX_LAB_TOOLS } from '../routes/lab';

// The shop's tool database for CAM AI: read and changed by those who may use CAM AI, nobody else.
let mf: Miniflare;
let DB: D1Database;
const admin: AuthedUser = { id: 'u-admin', username: 'chef', role: 'ADMIN' };
const omar: AuthedUser = { id: 'u-omar', username: 'omar', role: 'MACHINIST', toolpathBeta: true };

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-01-01', script: 'export default { fetch: () => new Response() }', d1Databases: ['DB'] }));
  DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  await ensureSchema(DB, 'ma');
}, 60_000);
afterAll(() => mf?.dispose());

type Out = { status: number; data: { tools: { family: string; code: string; tool: unknown; by: string }[] } | null };
const call = (handler: (c: Ctx) => Promise<Response>, user: AuthedUser, opts: { method?: string; body?: unknown; query?: string; region?: string } = {}): Promise<Out> => {
  const url = new URL(`https://cnc.test/api/lab/tools${opts.query ?? ''}`);
  const request = new Request(url, opts.body === undefined ? { method: opts.method ?? 'GET' } : { method: opts.method ?? 'PUT', body: JSON.stringify(opts.body), headers: { 'Content-Type': 'application/json' } });
  return handler({ env: { DB, REGION: opts.region ?? 'ma' } as Ctx['env'], request, url, params: {}, user }).then(
    async (r) => ({ status: r.status, data: (await r.json()) as Out['data'] }),
    (e) => (e instanceof HttpError ? { status: e.status, data: null } : Promise.reject(e)),
  );
};
const set = (f: object) => DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('features', ?, 0)").bind(JSON.stringify(f)).run();

describe("CAM AI's tool database", () => {
  const added = { family: 'ALU', code: 'SF_07.00_038_000_ALHS', tool: { added: { type: 'SF', d: 7, length: 38 }, cuts: { contour: { s: 12000, f: 1500 } } } };

  it('is saved, listed with who changed it, and reset to the template', async () => {
    expect((await call(handleSaveLabTool, admin, { body: added })).status).toBe(200);
    expect((await call(handleSaveLabTool, admin, { body: { family: 'ALU', code: 'SF_08.00_040_000_ALHS', tool: { removed: true } } })).status).toBe(200);
    // Saved again: changed in place.
    expect((await call(handleSaveLabTool, admin, { body: { ...added, tool: { ...added.tool, cuts: { contour: { f: 1200 } } } } })).status).toBe(200);
    const list = await call(handleListLabTools, admin);
    expect(list.status).toBe(200);
    expect(list.data?.tools).toHaveLength(2);
    expect(list.data?.tools.find((t) => t.code === added.code)).toMatchObject({ family: 'ALU', by: 'chef', tool: { added: { type: 'SF', d: 7, length: 38 }, cuts: { contour: { f: 1200 } } } });
    expect((await call(handleResetLabTool, admin, { method: 'DELETE', query: '?family=ALU&code=SF_08.00_040_000_ALHS' })).status).toBe(200);
    expect((await call(handleListLabTools, admin)).data?.tools.map((t) => t.code)).toEqual([added.code]);
    // Every change is in the security log, with the tool.
    const log = await DB.prepare("SELECT action, username, detail FROM audit_log WHERE action LIKE 'lab_tool_%' ORDER BY id").all<{ action: string; username: string; detail: string }>();
    expect(log.results.map((r) => r.action)).toEqual(['lab_tool_saved', 'lab_tool_saved', 'lab_tool_saved', 'lab_tool_reset']);
    expect(log.results[3]).toMatchObject({ username: 'chef', detail: 'ALU SF_08.00_040_000_ALHS' });
  });

  it('refuses values the planner may not take, and anything that could break a G-code comment', async () => {
    const bad = [
      { ...added, code: 'SF_07.00_038_000_ALHS) M30 (' },
      { ...added, family: 'POM' },
      { ...added, tool: { added: { type: 'KF', d: 7, length: 38 } } },
      { ...added, tool: { cuts: { contour: { f: 99999 } } } },
      { ...added, tool: { removed: true, cuts: { contour: { f: 500 } } } },
      { ...added, tool: 'x' },
    ];
    for (const body of bad) expect((await call(handleSaveLabTool, admin, { body })).status).toBe(400);
    expect((await call(handleResetLabTool, admin, { method: 'DELETE', query: '?family=ALU&code=%27%3B' })).status).toBe(400);
  });

  it('holds at most MAX_LAB_TOOLS rows; a saved one can still be changed', async () => {
    // Filled in one statement (a thousand separate inserts outlast the test's time under the full suite's load).
    await DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ? - 1)
       INSERT OR IGNORE INTO lab_tools (family, code, data, updated_by, updated_at) SELECT 'FH', 'SB_' || printf('%03d', i) || '.00_050_000_FH', '{"removed":true}', 'x', 0 FROM n`,
    )
      .bind(MAX_LAB_TOOLS)
      .run();
    expect((await call(handleSaveLabTool, admin, { body: { family: 'FH', code: 'SB_05.50_050_000_FH', tool: { removed: true } } })).status).toBe(409);
    expect((await call(handleSaveLabTool, admin, { body: { family: 'FH', code: 'SB_000.00_050_000_FH', tool: { cuts: { drill: { f: 300 } } } } })).status).toBe(200);
    await DB.prepare("DELETE FROM lab_tools WHERE family = 'FH'").run();
  }, 30_000);

  it('is not there for anyone who may not use CAM AI', async () => {
    // A machinist, even a toolpath tester; another country; CAM AI switched off: as if it did not exist.
    expect((await call(handleListLabTools, omar)).status).toBe(404);
    expect((await call(handleSaveLabTool, omar, { body: added })).status).toBe(404);
    expect((await call(handleResetLabTool, omar, { method: 'DELETE', query: '?family=ALU&code=SF_07.00_038_000_ALHS' })).status).toBe(404);
    expect((await call(handleListLabTools, admin, { region: 'tr' })).status).toBe(404);
    await set({ camAi: false });
    expect((await call(handleListLabTools, admin)).status).toBe(404);
    expect((await call(handleSaveLabTool, admin, { body: added })).status).toBe(404);
    await DB.prepare("DELETE FROM settings WHERE key = 'features'").run();
    expect((await call(handleListLabTools, admin)).status).toBe(200);
  });
});
