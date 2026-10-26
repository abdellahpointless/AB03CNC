import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ensureSchema } from '../schema';
import { claimPending, listRecipients, missedTaskAlert, notify } from '../alerts';
import type { Env } from '../context';

// Several people on Telegram: a master invites someone by name, they press Start with the link,
// and from then on they get the alerts (e.g. a task reported "not done").
let mf: Miniflare;
let hub: D1Database;
const env = { TELEGRAM_BOT_TOKEN: 'test', TELEGRAM_API_BASE: 'https://tg.test' } as unknown as Env;
let updates: unknown[] = [];
const sent: { chat_id: number; text: string }[] = [];

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, compatibilityDate: '2026-01-01', script: 'export default { fetch: () => new Response() }', d1Databases: ['DB'] }));
  hub = (await mf.getD1Database('DB')) as unknown as D1Database;
  await ensureSchema(hub, 'master');
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    const method = url.split('/').pop();
    const body = JSON.parse(init.body);
    if (method === 'sendMessage') sent.push(body);
    const result = method === 'getUpdates' ? updates : {};
    return new Response(JSON.stringify({ ok: true, result }));
  });
}, 60_000);
afterAll(() => {
  vi.unstubAllGlobals();
  return mf?.dispose();
});

const pending = (code: string, link: object, at = Date.now()) =>
  hub.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').bind(`alerts:link:${code}`, JSON.stringify(link), at).run();
const start = (id: number, chat: number, code: string) => ({ update_id: id, message: { text: `/start ${code}`, chat: { id: chat, type: 'private', first_name: `P${chat}` } } });

describe('telegram people', () => {
  it('adds an invited person when they press Start, even days later', async () => {
    await pending('invitecode1', { userId: 'p_karim', username: 'Karim (shift 2)', lang: 'en', invite: true }, Date.now() - 3 * 86_400_000);
    updates = [start(1, 111, 'invitecode1')];
    expect(await claimPending(env, hub)).toEqual(['p_karim']);
    const r = (await listRecipients(hub)).find((x) => x.userId === 'p_karim');
    expect(r?.chatId).toBe(111);
    expect(r?.modes.missedTask).toBe('message');
    expect(await claimPending(env, hub)).toEqual([]); // the link works once
  });
  it('ignores an own link older than 15 minutes', async () => {
    await pending('selfcode22', { userId: 'u-boss', username: 'boss', lang: 'en' }, Date.now() - 20 * 60_000);
    updates = [start(2, 222, 'selfcode22')];
    expect(await claimPending(env, hub)).toEqual([]);
  });
  it('sends a "not done" report to everyone linked', async () => {
    sent.length = 0;
    updates = [];
    const a = missedTaskAlert('ma', 'HAAS-1', 'Chips out, door closed', 'ali', 'youssef');
    await notify(env, hub, 'missedTask', a.message, a.call);
    expect(sent.map((m) => m.chat_id)).toEqual([111]);
    expect(sent[0].text).toContain('Not done by: ali');
    expect(sent[0].text).toContain('Reported by: youssef');
  });
});
