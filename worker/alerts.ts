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

export type AlertEvent = 'machineProblem' | 'lockout' | 'safetyOverride';
export type AlertMode = 'off' | 'message' | 'call';
export const ALERT_EVENTS: AlertEvent[] = ['machineProblem', 'lockout', 'safetyOverride'];
export const DEFAULT_MODES: Record<AlertEvent, AlertMode> = { machineProblem: 'message', lockout: 'message', safetyOverride: 'message' };

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

/** True when the same alert was already sent within the window (no flood of identical alerts). */
async function recentlySent(hub: D1Database, key: string, windowMs: number): Promise<boolean> {
  const now = Date.now();
  const row = await hub.prepare('SELECT updated_at FROM settings WHERE key = ?').bind(`alerts:last:${key}`).first<{ updated_at: number }>();
  if (row && now - row.updated_at < windowMs) return true;
  await hub
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, '', ?)
       ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at`,
    )
    .bind(`alerts:last:${key}`, now)
    .run();
  return false;
}

/** Sends an alert to every linked master who wants this event. Never throws. */
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
    const recipients = (await listRecipients(hub)).filter((r) => r.modes[event] !== 'off');
    if (!recipients.length) return;
    if (dedupeKey && (await recentlySent(hub, `${event}:${dedupeKey}`, 10 * 60 * 1000))) return;
    await Promise.all(
      recipients.map(async (r) => {
        try {
          await telegram(env, 'sendMessage', { chat_id: r.chatId, text: message[r.lang] });
          if (r.modes[event] === 'call' && r.tgUsername) await telegramCall(env, r.tgUsername, call[r.lang], r.lang);
        } catch (err) {
          console.error('alert not delivered to', r.username, err instanceof Error ? err.message : err);
        }
      }),
    );
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
