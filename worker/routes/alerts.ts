import { HttpError, json, readJson, str } from '../http';
import type { Ctx } from '../context';
import { auditCtx } from '../security';
import {
  ALERT_EVENTS,
  claimPending,
  listRecipients,
  notifyLater,
  safetyOverrideAlert,
  saveRecipient,
  telegram,
  telegramCall,
  telegramConfigured,
  type AlertMode,
  type PendingLink,
  type Recipient,
} from '../alerts';

/*
 * Master dashboard: link a Telegram chat, choose what to receive, send a test.
 *
 * Linking without a webhook: the dashboard shows a t.me link with a one-time code; the person
 * presses Start in Telegram, and the bot's recent messages (getUpdates) are read to find the chat
 * that sent that code (see claimPending). A master links their own chat, and can invite any number
 * of other people by name: they get a link to open, and receive every alert once they press Start.
 */

const MODES: AlertMode[] = ['off', 'message', 'call'];

async function botUsername(ctx: Ctx): Promise<string | null> {
  const hub = ctx.env.DB;
  const cached = await hub.prepare("SELECT value, updated_at FROM settings WHERE key = 'alerts:bot'").first<{ value: string; updated_at: number }>();
  if (cached && Date.now() - cached.updated_at < 86_400_000) return cached.value || null;
  try {
    const me = await telegram<{ username: string }>(ctx.env, 'getMe');
    await hub
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('alerts:bot', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(me.username, Date.now())
      .run();
    return me.username;
  } catch (err) {
    console.error('telegram getMe failed', err instanceof Error ? err.message : err);
    return null;
  }
}

async function myRecipient(ctx: Ctx): Promise<Recipient | null> {
  return (await listRecipients(ctx.env.DB)).find((r) => r.userId === ctx.user!.id) ?? null;
}

function publicRecipient(r: Recipient | null) {
  return r && { name: r.name, tgUsername: r.tgUsername, lang: r.lang, modes: r.modes, linkedAt: r.linkedAt };
}

/** People a master invited (ids start with "p_"), linked or still waiting for them to press Start. */
async function invitedPeople(ctx: Ctx, bot: string | null) {
  const linked = (await listRecipients(ctx.env.DB))
    .filter((r) => r.userId.startsWith('p_'))
    .map((r) => ({ id: r.userId, label: r.username, name: r.name, linkedAt: r.linkedAt, url: null as string | null }));
  const { results } = await ctx.env.DB.prepare("SELECT key, value, updated_at FROM settings WHERE key LIKE 'alerts:link:%'").all<{ key: string; value: string; updated_at: number }>();
  const waiting = results
    .map((r) => ({ code: r.key.slice('alerts:link:'.length), link: JSON.parse(r.value) as PendingLink, at: r.updated_at }))
    .filter((w) => w.link.invite && !linked.some((l) => l.id === w.link.userId))
    .map((w) => ({ id: w.link.userId, label: w.link.username, name: null, linkedAt: null, url: bot ? `https://t.me/${bot}?start=${w.code}` : null }));
  return [...linked, ...waiting].sort((a, b) => a.label.localeCompare(b.label));
}

async function newLink(ctx: Ctx, link: PendingLink): Promise<{ url: string; code: string }> {
  if (!telegramConfigured(ctx.env)) throw new HttpError(409, 'Telegram is not set up yet');
  const bot = await botUsername(ctx);
  if (!bot) throw new HttpError(502, 'Telegram could not be reached. Check the bot token.');
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  const code = Array.from(bytes, (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
  await ctx.env.DB.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').bind(`alerts:link:${code}`, JSON.stringify(link), Date.now()).run();
  return { url: `https://t.me/${bot}?start=${code}`, code };
}

// GET /master/api/alerts
export async function handleAlertsStatus(ctx: Ctx): Promise<Response> {
  const configured = telegramConfigured(ctx.env);
  if (configured) await claimPending(ctx.env, ctx.env.DB);
  const bot = configured ? await botUsername(ctx) : null;
  return json({
    configured,
    bot,
    me: publicRecipient(await myRecipient(ctx)),
    people: await invitedPeople(ctx, bot),
    events: ALERT_EVENTS,
  });
}

// POST /master/api/alerts/link { lang } -> { url } (a t.me link with a one-time code)
export async function handleAlertsLink(ctx: Ctx): Promise<Response> {
  const body = await readJson<{ lang?: unknown }>(ctx.request, 500);
  return json(await newLink(ctx, { userId: ctx.user!.id, username: ctx.user!.username, lang: body.lang === 'tr' ? 'tr' : 'en', by: ctx.user!.id }));
}

// POST /master/api/alerts/invite { name, lang } -> { url }: a link for someone else, valid 7 days
export async function handleAlertsInvite(ctx: Ctx): Promise<Response> {
  const body = await readJson<{ name?: unknown; lang?: unknown }>(ctx.request, 500);
  const name = str(body.name, 'Name', { min: 1, max: 60 });
  const id = `p_${crypto.randomUUID().slice(0, 12)}`;
  const link = await newLink(ctx, { userId: id, username: name, lang: body.lang === 'tr' ? 'tr' : 'en', by: ctx.user!.id, invite: true });
  await auditCtx(ctx, 'telegram_invited', name);
  return json({ ...link, id });
}

// DELETE /master/api/alerts/people/:id  (a person who was invited, linked or not yet)
export async function handleAlertsRemovePerson(ctx: Ctx): Promise<Response> {
  const id = ctx.params.id;
  if (!/^p_[a-z0-9-]{1,40}$/.test(id)) throw new HttpError(400, 'Invalid person');
  const db = ctx.env.DB;
  await db.prepare('DELETE FROM settings WHERE key = ?').bind(`alerts:recipient:${id}`).run();
  const { results } = await db.prepare("SELECT key, value FROM settings WHERE key LIKE 'alerts:link:%'").all<{ key: string; value: string }>();
  for (const r of results) if ((JSON.parse(r.value) as PendingLink).userId === id) await db.prepare('DELETE FROM settings WHERE key = ?').bind(r.key).run();
  await auditCtx(ctx, 'telegram_person_removed', id);
  return json({ ok: true });
}

// POST /master/api/alerts/link/check { code } -> { linked }
export async function handleAlertsLinkCheck(ctx: Ctx): Promise<Response> {
  const body = await readJson<{ code?: unknown }>(ctx.request, 500);
  const code = str(body.code, 'Code', { min: 6, max: 20 });
  const pending = await ctx.env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(`alerts:link:${code}`).first<{ value: string }>();
  if (pending && (JSON.parse(pending.value) as PendingLink).userId !== ctx.user!.id) throw new HttpError(403, 'This link belongs to another account');
  const added = await claimPending(ctx.env, ctx.env.DB);
  if (added.includes(ctx.user!.id)) {
    const me = await myRecipient(ctx);
    await auditCtx(ctx, 'telegram_linked', me?.name ?? '');
    return json({ linked: true, me: publicRecipient(me) });
  }
  if (!pending) throw new HttpError(410, 'This link has expired. Create a new one.');
  return json({ linked: false });
}

// PUT /master/api/alerts/me { modes?, tgUsername?, lang? }
export async function handleAlertsUpdate(ctx: Ctx): Promise<Response> {
  const rec = await myRecipient(ctx);
  if (!rec) throw new HttpError(404, 'Telegram is not linked');
  const body = await readJson<{ modes?: Record<string, unknown>; tgUsername?: unknown; lang?: unknown }>(ctx.request, 2000);
  if (body.modes && typeof body.modes === 'object') {
    for (const e of ALERT_EVENTS) {
      const m = body.modes[e];
      if (m === undefined) continue;
      if (!MODES.includes(m as AlertMode)) throw new HttpError(400, 'Invalid value');
      rec.modes[e] = m as AlertMode;
    }
  }
  if (body.tgUsername !== undefined) {
    const u = String(body.tgUsername ?? '').trim().replace(/^@/, '');
    if (u && !/^[A-Za-z0-9_]{4,32}$/.test(u)) throw new HttpError(400, 'Invalid Telegram username');
    rec.tgUsername = u || null;
  }
  if (body.lang === 'en' || body.lang === 'tr') rec.lang = body.lang;
  await saveRecipient(ctx.env.DB, rec);
  return json({ ok: true, me: publicRecipient(rec) });
}

// POST /master/api/alerts/test { call?: boolean }
export async function handleAlertsTest(ctx: Ctx): Promise<Response> {
  const rec = await myRecipient(ctx);
  if (!rec) throw new HttpError(404, 'Telegram is not linked');
  const body = await readJson<{ call?: unknown }>(ctx.request, 200);
  let detail = '';
  try {
    if (body.call === true) {
      if (!rec.tgUsername) throw new HttpError(400, 'Add your Telegram username first');
      detail = await telegramCall(ctx.env, rec.tgUsername, rec.lang === 'tr' ? 'Bu, CNC Process Pro test aramasıdır.' : 'This is a test call from CNC Process Pro.', rec.lang);
    } else {
      await telegram(ctx.env, 'sendMessage', {
        chat_id: rec.chatId,
        text: rec.lang === 'tr' ? '🔔 Test mesajı: CNC Process Pro uyarıları çalışıyor.' : '🔔 Test message: CNC Process Pro alerts are working.',
      });
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, err instanceof Error ? err.message : 'Telegram could not be reached');
  }
  return json({ ok: true, detail });
}

// DELETE /master/api/alerts/me
export async function handleAlertsUnlink(ctx: Ctx): Promise<Response> {
  await ctx.env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(`alerts:recipient:${ctx.user!.id}`).run();
  await auditCtx(ctx, 'telegram_unlinked');
  return json({ ok: true });
}

// Country app: POST /api/alerts/safety-override { machine, program, errors }
// Sent when someone exports a program although the safety check found red problems.
export async function handleSafetyOverride(ctx: Ctx): Promise<Response> {
  const body = await readJson<{ machine?: unknown; program?: unknown; errors?: unknown }>(ctx.request, 1000);
  const machine = str(body.machine, 'Machine', { min: 1, max: 60 });
  const program = str(body.program, 'Program', { min: 1, max: 120 });
  const errors = Math.max(1, Math.min(99, Math.round(Number(body.errors) || 1)));
  const a = safetyOverrideAlert(ctx.env.REGION, machine, program, errors, ctx.user!.username);
  await notifyLater(ctx, 'safetyOverride', a.message, a.call, `${ctx.user!.id}:${program}`);
  return json({ ok: true });
}
