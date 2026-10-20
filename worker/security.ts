import type { Ctx, Env } from './context';
import { HttpError } from './http';

/*
 * Small security toolbox shared by the routes: client IP, audit log, TOTP (RFC 6238),
 * recovery codes and the password policy.
 */

export function clientIp(request: Request): string {
  return (request.headers.get('CF-Connecting-IP') || '').slice(0, 64) || 'unknown';
}

/** Writes a security event. Never throws: logging must not break the request. */
export async function audit(
  env: Env,
  request: Request,
  action: string,
  who: { id?: string | null; username?: string | null } | null,
  detail?: string,
): Promise<void> {
  try {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO audit_log (at, user_id, username, ip, action, detail) VALUES (?, ?, ?, ?, ?, ?)').bind(
        now,
        who?.id ?? null,
        who?.username?.slice(0, 100) ?? null,
        clientIp(request),
        action,
        detail ? detail.slice(0, 300) : null,
      ),
      // Keep one year of history.
      env.DB.prepare('DELETE FROM audit_log WHERE at < ?').bind(now - 365 * 24 * 3600 * 1000),
    ]);
  } catch (err) {
    console.error('audit log write failed', err instanceof Error ? err.message : err);
  }
}

export function auditCtx(ctx: Ctx, action: string, detail?: string) {
  return audit(ctx.env, ctx.request, action, ctx.user, detail);
}

// ---- Bytes / encodings -----------------------------------------------------------

export function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function constantTimeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  return constantTimeEqual(enc.encode(a), enc.encode(b));
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  const out: number[] = [];
  let bits = 0, value = 0;
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

// ---- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ------------------------------------------

export const TOTP_STEP_SECONDS = 30;

export function newTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

async function hotp(secret: Uint8Array, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new ArrayBuffer(8);
  const view = new DataView(msg);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const offset = mac[mac.length - 1] & 0xf;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

/**
 * Checks a 6-digit code against the current time step (±1 step for clock drift).
 * Returns the matched step so the caller can refuse to accept the same code twice.
 */
export async function verifyTotp(secretB32: string, code: string, lastUsedStep: number, now = Date.now()): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretB32);
  const step = Math.floor(now / 1000 / TOTP_STEP_SECONDS);
  for (const s of [step, step - 1, step + 1]) {
    if (s <= lastUsedStep) continue;
    if (constantTimeEqualStr(await hotp(secret, s), code)) return s;
  }
  return null;
}

export function otpauthUrl(secret: string, username: string, issuer = 'CNC Process Pro'): string {
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${username}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/** Ten single-use recovery codes like "7KQ4-MZ2P". Stored hashed. */
export function newRecoveryCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < 10; i++) {
    const raw = base32Encode(crypto.getRandomValues(new Uint8Array(5))).slice(0, 8);
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }
  return codes;
}

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z2-7]/g, '');
}

// ---- Password policy ---------------------------------------------------------------

export const MIN_PASSWORD_LENGTH = 8;
export const MIN_ADMIN_PASSWORD_LENGTH = 10;

const COMMON = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890', '11111111', '00000000',
  'qwerty123', 'qwertyuiop', 'azerty123', 'azertyuiop', 'motdepasse', 'iloveyou', 'admin123', 'administrator',
  'welcome1', 'letmein1', 'abc12345', 'changeme', 'passw0rd', 'p@ssw0rd', 'football', 'baseball', 'sunshine',
  'cncprocess', 'cncprocesspro', 'machinist', 'operator', 'haas1234', 'fanuc123', 'atelier123', 'bienvenue',
]);

/** Returns an error message, or null when the password is acceptable. */
export function passwordProblem(password: string, username: string, role: 'ADMIN' | 'MACHINIST'): string | null {
  const min = role === 'ADMIN' ? MIN_ADMIN_PASSWORD_LENGTH : MIN_PASSWORD_LENGTH;
  if (password.length < min) return `Password must be at least ${min} characters${role === 'ADMIN' ? ' for an admin account' : ''}.`;
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(password) || /^(0123456789|123456789|987654321)/.test(password)) {
    return 'This password is too common. Choose something harder to guess.';
  }
  if (username && lower.includes(username.toLowerCase()) && username.length >= 3) {
    return 'The password must not contain the username.';
  }
  return null;
}

// ---- Quotas ------------------------------------------------------------------------

/**
 * Counts one use of `key` in a fixed window and refuses with 429 past `limit`.
 * One upsert per call; old windows are reset in place, so the table stays small.
 */
export async function consumeQuota(env: Env, key: string, limit: number, windowMs: number, message: string): Promise<void> {
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, window_start) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start < ?3 THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN window_start < ?3 THEN ?2 ELSE window_start END
     RETURNING count`,
  )
    .bind(key, now, now - windowMs)
    .first<{ count: number }>();
  if ((row?.count ?? 0) > limit) throw new HttpError(429, message);
}
