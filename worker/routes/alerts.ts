import { HttpError, json, readJson, str } from '../http';
import type { Ctx } from '../context';
import { auditCtx } from '../security';
import {
  ALERT_EVENTS,
  DEFAULT_MODES,
  listRecipients,
  notifyLater,
  safetyOverrideAlert,
  saveRecipient,
  telegram,
  telegramCall,
  telegramConfigured,
  type AlertMode,
  type Recipient,
} from '../alerts';

/*
 * Master dashboard: link a Telegram chat, choose what to receive, send a test.
 *
 * Linking without a webhook: the dashboard shows a t.me link with a one-time code; the master
 * presses Start in Telegram, then "Check" here reads the bot's recent messages (getUpdates) and
 * saves the chat that sent that code. Codes expire after 15 minutes and work once.
 */

const LINK_TTL_MS = 15 * 60 * 1000;
const MODES: AlertMode[] = ['off', 'message', 'call'];

interface TgUpdate {
  update_id: number;
  message?: { text?: string; chat: { id: number; type: string; first_name?: string; username?: string }; from?: { username?: string; first_name?: string } };
}

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

// GET /master/api/alerts
export async function handleAlertsStatus(ctx: Ctx): Promise<Response> {
  const configured = telegramConfigured(ctx.env);
  return json({
    configured,
    bot: configured ? await botUsername(ctx) : null,
    me: publicRecipient(await myRecipient(ctx)),
    events: ALERT_EVENTS,
  });
}

// POST /master/api/alerts/link { lang } -> { url } (a t.me link with a one-time code)
export async function handleAlertsLink(ctx: Ctx): Promise<Response> {
  if (!telegramConfigured(ctx.env)) throw new HttpError(409, 'Telegram is not set up yet');
  const bot = await botUsername(ctx);
  if (!bot) throw new HttpError(502, 'Telegram could not be reached. Check the bot token.');
  const body = await readJson<{ lang?: unknown }>(ctx.request, 500);
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  const code = Array.from(bytes, (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
  await ctx.env.DB.prepare(
    "DELETE FROM settings WHERE key LIKE 'alerts:link:%' AND updated_at < ?",
  ).bind(Date.now() - LINK_TTL_MS).run();
  await ctx.env.DB.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
    .bind(`alerts:link:${code}`, JSON.stringify({ userId: ctx.user!.id, username: ctx.user!.username, lang: body.lang === 'tr' ? 'tr' : 'en' }), Date.now())
    .run();
  return json({ url: `https://t.me/${bot}?start=${code}`, code });
}

// POST /master/api/alerts/link/check { code } -> { linked }
export async function handleAlertsLinkCheck(ctx: Ctx): Promise<Response> {
  const body = await readJson<{ code?: unknown }>(ctx.request, 500);
  const code = str(body.code, 'Code', { min: 6, max: 20 });
  const pending = await ctx.env.DB.prepare('SELECT value, updated_at FROM settings WHERE key = ?')
    .bind(`alerts:link:${code}`)
    .first<{ value: string; updated_at: number }>();
  if (!pending || Date.now() - pending.updated_at > LINK_TTL_MS) throw new HttpError(410, 'This link has expired. Create a new one.');
  const link = JSON.parse(pending.value) as { userId: string; username: string; lang: 'en' | 'tr' };
  if (link.userId !== ctx.user!.id) throw new HttpError(403, 'This link belongs to another account');

  const offsetRow = await ctx.env.DB.prepare("SELECT value FROM settings WHERE key = 'alerts:offset'").first<{ value: string }>();
  const updates = await telegram<TgUpdate[]>(ctx.env, 'getUpdates', {
    offset: Number(offsetRow?.value ?? 0) || undefined,
    timeout: 0,
    allowed_updates: ['message'],
  });
  let found: TgUpdate['message'] | undefined;
  for (const u of updates) {
    const m = u.message;
    if (m?.chat.type === 'private' && m.text?.trim() === `/start ${code}`) found = m;
  }
  // Updates older than this check are done with (Telegram keeps them 24 h otherwise).
  if (updates.length) {
    await ctx.env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('alerts:offset', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
      .bind(String(updates[updates.length - 1].update_id + 1), Date.now())
      .run();
  }
  if (!found) return json({ linked: false });

  const previous = await myRecipient(ctx);
  const rec: Recipient = {
    userId: link.userId,
    username: link.username,
    chatId: found.chat.id,
    name: found.chat.first_name || found.from?.first_name || found.chat.username || 'Telegram',
    lang: link.lang,
    tgUsername: found.from?.username ?? found.chat.username ?? previous?.tgUsername ?? null,
    modes: previous?.modes ?? { ...DEFAULT_MODES },
    linkedAt: Date.now(),
  };
  await saveRecipient(ctx.env.DB, rec);
  await ctx.env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(`alerts:link:${code}`).run();
  await auditCtx(ctx, 'telegram_linked', rec.name);
  await telegram(ctx.env, 'sendMessage', {
    chat_id: rec.chatId,
    text: rec.lang === 'tr'
      ? `✅ CNC Process Pro uyarıları bu sohbete gelecek (${rec.username}).`
      : `✅ CNC Process Pro alerts will arrive in this chat (${rec.username}).`,
  }).catch(() => undefined);
  return json({ linked: true, me: publicRecipient(rec) });
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
