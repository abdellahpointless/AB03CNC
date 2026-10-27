import type { Ctx, Env } from './context';
import { regionById, type RegionId } from '../src/regions';

/*
 * Alerts to the master admins on Telegram: a message from the app's bot, and optionally a
 * voice call (Telegram call placed by the free CallMeBot service, which reads the alert out).
 *
 * The bot token is a Worker secret (TELEGRAM_BOT_TOKEN), never stored in a database. Each master
 * links their own Telegram chat from the dashboard; the link and the choice per event live in
 * the hub database (settings "alerts:recipient:<user id>"). Nothing here may ever break the
 * action that triggered it: every failure is logged and swallowed.
 */

export type AlertEvent = 'machineProblem' | 'missedTask' | 'lockout' | 'safetyOverride';
export type AlertMode = 'off' | 'message' | 'call';
export const ALERT_EVENTS: AlertEvent[] = ['machineProblem', 'missedTask', 'lockout', 'safetyOverride'];
export const DEFAULT_MODES: Record<AlertEvent, AlertMode> = { machineProblem: 'message', missedTask: 'message', lockout: 'message', safetyOverride: 'message' };

export interface Recipient {
  userId: string;
  username: string;
  chatId: number;
  name: string;
  lang: 'en' | 'tr';
  /** Telegram @username, needed for calls. */
  tgUsername: string | null;
  modes: Record<AlertEvent, AlertMode>;
  linkedAt: number;
}

/** Text in each language the masters can read. */
export type Bilingual = { en: string; tr: string };

const telegramBase = (env: Env) => env.TELEGRAM_API_BASE || 'https://api.telegram.org';
const callBase = (env: Env) => env.CALLMEBOT_API_BASE || 'https://api.callmebot.com';

export function telegramConfigured(env: Env): boolean {
  return !!env.TELEGRAM_BOT_TOKEN;
}

/** One Telegram Bot API call. Throws with Telegram's own description when it refuses. */
export async function telegram<T = unknown>(env: Env, method: string, body: Record<string, unknown> = {}): Promise<T> {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('Telegram is not set up');
  const res = await fetch(`${telegramBase(env)}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const data = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null;
  if (!data?.ok) throw new Error(`Telegram: ${data?.description ?? res.status}`);
  return data.result as T;
}

/** A Telegram voice call that reads the text out (CallMeBot; the person authorised it once). */
export async function telegramCall(env: Env, tgUsername: string, text: string, lang: 'en' | 'tr'): Promise<string> {
  const qs = new URLSearchParams({
    source: 'web',
    user: `@${tgUsername.replace(/^@/, '')}`,
    text: text.slice(0, 250),
    lang: lang === 'tr' ? 'tr-TR-Standard-A' : 'en-GB-Standard-B',
    rpt: '2',
  });
  const res = await fetch(`${callBase(env)}/start.php?${qs}`, { signal: AbortSignal.timeout(10000) });
  const reply = callReplyText(await res.text());
  if (!res.ok || callFailed(reply)) throw new Error(`Call: ${callReplyTail(reply) || res.status}`);
  return callReplyTail(reply);
}

/** The end of CallMeBot's reply, where it says what happened (the start is its step log). */
export function callReplyTail(text: string, max = 300): string {
  return text.length > max ? `…${text.slice(-max).trim()}` : text;
}

/**
 * CallMeBot answers with a small web page. Only its visible text matters: scripts and styles
 * (analytics code) are removed, so neither the error check nor the message shown can be fooled
 * by the word "error" inside a script.
 */
export function callReplyText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function callFailed(text: string): boolean {
  // CallMeBot logs its steps; once it says the call is starting, the call went out.
  if (/starting telegram audio call|call (?:queued|started|placed)/i.test(text)) return false;
  return /not authori[sz]ed|authori[sz]e callmebot|\berror\b|invalid|not found|too many|blocked|limit/i.test(text);
}

export async function listRecipients(hub: D1Database): Promise<Recipient[]> {
  const { results } = await hub.prepare("SELECT value FROM settings WHERE key LIKE 'alerts:recipient:%'").all<{ value: string }>();
  const out: Recipient[] = [];
  for (const r of results) {
    try {
      const rec = JSON.parse(r.value) as Recipient;
      rec.modes = { ...DEFAULT_MODES, ...rec.modes };
      out.push(rec);
    } catch {
      /* skip a damaged row */
    }
  }
  return out;
}

export async function saveRecipient(hub: D1Database, rec: Recipient): Promise<void> {
  await hub
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(`alerts:recipient:${rec.userId}`, JSON.stringify(rec), Date.now())
    .run();
}

/** True when the same alert was already delivered within the window (no flood of identical alerts). */
async function recentlySent(hub: D1Database, key: string, windowMs: number): Promise<boolean> {
  const row = await hub.prepare('SELECT updated_at FROM settings WHERE key = ?').bind(`alerts:last:${key}`).first<{ updated_at: number }>();
  return !!row && Date.now() - row.updated_at < windowMs;
}

/** Remembered only after a message really went out, so a failed send can be retried at once. */
async function markSent(hub: D1Database, key: string): Promise<void> {
  await hub
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, '', ?)
       ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at`,
    )
    .bind(`alerts:last:${key}`, Date.now())
    .run();
}

// ---- Linking chats (no webhook) ----------------------------------------------------------
// A link is a one-time code in a t.me/<bot>?start=<code> link. Whoever presses Start with it is
// added: a master linking their own chat (15 minutes), or another person a master invited by name
// (7 days, the link is sent to them). The bot's recent messages are read with getUpdates.

export interface PendingLink {
  userId: string;
  username: string;
  lang: 'en' | 'tr';
  /** The master who made the link. */
  by?: string;
  invite?: boolean;
}
export const LINK_TTL_MS = 15 * 60 * 1000;
export const INVITE_TTL_MS = 7 * 86_400_000;

interface TgUpdate {
  update_id: number;
  message?: { text?: string; chat: { id: number; type: string; first_name?: string; username?: string }; from?: { username?: string; first_name?: string } };
}

/** Adds everyone who pressed Start with a pending link; returns the user ids added. Never throws. */
export async function claimPending(env: Env, hub: D1Database): Promise<string[]> {
  try {
    const now = Date.now();
    const { results } = await hub.prepare("SELECT key, value, updated_at FROM settings WHERE key LIKE 'alerts:link:%'").all<{ key: string; value: string; updated_at: number }>();
    const pending = new Map<string, PendingLink>();
    for (const r of results) {
      const link = JSON.parse(r.value) as PendingLink;
      if (now - r.updated_at > (link.invite ? INVITE_TTL_MS : LINK_TTL_MS)) await hub.prepare('DELETE FROM settings WHERE key = ?').bind(r.key).run();
      else pending.set(r.key.slice('alerts:link:'.length), link);
    }
    if (!pending.size || !telegramConfigured(env)) return [];
    const offsetRow = await hub.prepare("SELECT value FROM settings WHERE key = 'alerts:offset'").first<{ value: string }>();
    const updates = await telegram<TgUpdate[]>(env, 'getUpdates', { offset: Number(offsetRow?.value ?? 0) || undefined, timeout: 0, allowed_updates: ['message'] });
    if (updates.length) {
      // Updates older than this are done with (Telegram keeps them 24 h otherwise).
      await hub
        .prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES ('alerts:offset', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .bind(String(updates[updates.length - 1].update_id + 1), now)
        .run();
    }
    const added: string[] = [];
    const known = await listRecipients(hub);
    for (const u of updates) {
      const m = u.message;
      const code = m?.chat.type === 'private' ? /^\/start (\S+)$/.exec(m.text?.trim() ?? '')?.[1] : undefined;
      const link = code ? pending.get(code) : undefined;
      if (!m || !code || !link) continue;
      pending.delete(code);
      const previous = known.find((r) => r.userId === link.userId);
      const rec: Recipient = {
        userId: link.userId,
        username: link.username,
        chatId: m.chat.id,
        name: m.chat.first_name || m.from?.first_name || m.chat.username || 'Telegram',
        lang: link.lang,
        tgUsername: m.from?.username ?? m.chat.username ?? previous?.tgUsername ?? null,
        modes: previous?.modes ?? { ...DEFAULT_MODES },
        linkedAt: now,
      };
      await saveRecipient(hub, rec);
      await hub.prepare('DELETE FROM settings WHERE key = ?').bind(`alerts:link:${code}`).run();
      added.push(rec.userId);
      await telegram(env, 'sendMessage', {
        chat_id: rec.chatId,
        text: rec.lang === 'tr' ? `✅ CNC Process Pro uyarıları bu sohbete gelecek (${rec.username}).` : `✅ CNC Process Pro alerts will arrive in this chat (${rec.username}).`,
      }).catch(() => undefined);
    }
    return added;
  } catch (err) {
    console.error('telegram link check failed', err instanceof Error ? err.message : err);
    return [];
  }
}

/** Sends an alert to every linked person (masters and the people they invited) who wants this event. Never throws. */
export async function notify(
  env: Env,
  hub: D1Database | undefined,
  event: AlertEvent,
  message: Bilingual,
  call: Bilingual,
  dedupeKey?: string,
): Promise<void> {
  try {
    if (!hub || !telegramConfigured(env)) return;
    await claimPending(env, hub); // someone invited may have pressed Start since
    const recipients = (await listRecipients(hub)).filter((r) => r.modes[event] !== 'off');
    if (!recipients.length) return;
    const key = dedupeKey && `${event}:${dedupeKey}`;
    if (key && (await recentlySent(hub, key, 10 * 60 * 1000))) return;
    const delivered = await Promise.all(
      recipients.map(async (r) => {
        try {
          await telegram(env, 'sendMessage', { chat_id: r.chatId, text: message[r.lang] });
          if (r.modes[event] === 'call' && r.tgUsername) await telegramCall(env, r.tgUsername, call[r.lang], r.lang);
          return true;
        } catch (err) {
          console.error('alert not delivered to', r.username, err instanceof Error ? err.message : err);
          return false;
        }
      }),
    );
    if (key && delivered.some(Boolean)) await markSent(hub, key);
  } catch (err) {
    console.error('alerts failed', err instanceof Error ? err.message : err);
  }
}

/** Runs the alert after the response is sent when the platform allows it. */
export function notifyLater(ctx: Ctx, event: AlertEvent, message: Bilingual, call: Bilingual, dedupeKey?: string): Promise<void> | void {
  const hub = ctx.env.REGION === 'master' ? ctx.env.DB : ctx.env.HUB;
  const job = notify(ctx.env, hub, event, message, call, dedupeKey);
  if (ctx.waitUntil) ctx.waitUntil(job);
  else return job;
}

// ---- Messages --------------------------------------------------------------------------

const FLAG: Record<RegionId, string> = { ma: '🇲🇦', tr: '🇹🇷' };
const COUNTRY: Record<RegionId, Bilingual> = { ma: { en: 'Morocco', tr: 'Fas' }, tr: { en: 'Türkiye', tr: 'Türkiye' } };

export function countryLabel(region: string | undefined): Bilingual {
  const r = regionById(region);
  if (!r) return { en: 'Master', tr: 'Ana yönetim' };
  return { en: `${FLAG[r.id]} ${COUNTRY[r.id].en}`, tr: `${FLAG[r.id]} ${COUNTRY[r.id].tr}` };
}

function countrySpoken(region: string | undefined): Bilingual {
  const r = regionById(region);
  return r ? COUNTRY[r.id] : { en: 'Master', tr: 'Ana yönetim' };
}

export function machineProblemAlert(region: string | undefined, machine: string, note: string, user: string, stops = false) {
  const c = countryLabel(region);
  const s = countrySpoken(region);
  return {
    message: {
      en: `🛠️ ${c.en} · ${machine}\n${stops ? '⛔ Machine stopped: ' : '❗ Problem reported: '}${note}\n👤 ${user}`,
      tr: `🛠️ ${c.tr} · ${machine}\n${stops ? '⛔ Tezgah durdu: ' : '❗ Arıza bildirildi: '}${note}\n👤 ${user}`,
    },
    call: {
      en: stops ? `Alert. ${s.en}, machine ${machine} is stopped. Reported by ${user}: ${note}.` : `Alert. ${s.en}, machine ${machine}. Problem reported by ${user}: ${note}.`,
      tr: stops ? `Uyarı. ${s.tr}, tezgah ${machine} durdu. ${user} bildirdi: ${note}.` : `Uyarı. ${s.tr}, tezgah ${machine}. ${user} arıza bildirdi: ${note}.`,
    },
  };
}

/** Someone reported the machine's vise (mengene) damaged. */
export function viseDamagedAlert(region: string | undefined, machine: string, note: string | null, user: string) {
  const c = countryLabel(region);
  const s = countrySpoken(region);
  const more = note ? `: ${note}` : '';
  return {
    message: {
      en: `🗜️ ${c.en} · ${machine}\n❗ Vise damaged${more}\n👤 ${user}`,
      tr: `🗜️ ${c.tr} · ${machine}\n❗ Mengene hasarlı${more}\n👤 ${user}`,
    },
    call: {
      en: `Alert. ${s.en}, machine ${machine}. ${user} reports the vise is damaged${more}.`,
      tr: `Uyarı. ${s.tr}, tezgah ${machine}. ${user} mengenenin hasarlı olduğunu bildirdi${more}.`,
    },
  };
}

/** The next shift reported that a start / end of shift task was not done. */
export function missedTaskAlert(region: string | undefined, machine: string, task: string, notDoneBy: string, reporter: string) {
  const c = countryLabel(region);
  const s = countrySpoken(region);
  return {
    message: {
      en: `📋 ${c.en} · ${machine}\n❌ Task not done in the previous shift: ${task}\n👤 Not done by: ${notDoneBy}\n🔎 Reported by: ${reporter}`,
      tr: `📋 ${c.tr} · ${machine}\n❌ Önceki vardiyada yapılmayan görev: ${task}\n👤 Yapmayan: ${notDoneBy}\n🔎 Bildiren: ${reporter}`,
    },
    call: {
      en: `${s.en}, machine ${machine}. ${reporter} reports that ${notDoneBy} did not do the task: ${task}.`,
      tr: `${s.tr}, tezgah ${machine}. ${reporter}, ${notDoneBy} kişisinin şu görevi yapmadığını bildirdi: ${task}.`,
    },
  };
}

export function lockoutAlert(region: string | undefined, username: string) {
  const c = countryLabel(region);
  const s = countrySpoken(region);
  return {
    message: {
      en: `🔒 ${c.en}\n🚫 Account locked after too many wrong passwords: ${username}\nIt unlocks by itself in 15 minutes.`,
      tr: `🔒 ${c.tr}\n🚫 Çok fazla hatalı şifre nedeniyle hesap kilitlendi: ${username}\n15 dakika sonra kendiliğinden açılır.`,
    },
    call: {
      en: `Security alert. ${s.en}. The account ${username} was locked after too many wrong passwords.`,
      tr: `Güvenlik uyarısı. ${s.tr}. ${username} hesabı çok fazla hatalı şifre nedeniyle kilitlendi.`,
    },
  };
}

export function safetyOverrideAlert(region: string | undefined, machine: string, program: string, errors: number, user: string) {
  const c = countryLabel(region);
  const s = countrySpoken(region);
  return {
    message: {
      en: `⚠️ ${c.en} · ${machine}\n🛡️ Exported with ${errors} safety problem${errors === 1 ? '' : 's'}: ${program}\n👤 ${user}`,
      tr: `⚠️ ${c.tr} · ${machine}\n🛡️ ${errors} güvenlik sorunuyla dışa aktarıldı: ${program}\n👤 ${user}`,
    },
    call: {
      en: `Safety alert. ${s.en}, machine ${machine}. ${user} exported program ${program} with ${errors} safety problems.`,
      tr: `Güvenlik uyarısı. ${s.tr}, tezgah ${machine}. ${user}, ${program} programını ${errors} güvenlik sorunuyla dışa aktardı.`,
    },
  };
}
