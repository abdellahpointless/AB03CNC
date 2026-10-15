import { HttpError, getCookie, json, readJson, str } from './http';
import { bumpVersion, type Ctx, type AuthedUser, type Env } from './context';
import { seedDefaultToolsIfEmpty } from './routes/tools';

export const SESSION_COOKIE = 'cnc_sid';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, sliding
const SESSION_RENEW_AFTER_MS = 15 * 24 * 60 * 60 * 1000;

// Login throttling (per username): after MAX_FAILURES wrong passwords inside
// FAILURE_WINDOW_MS, the account is locked for LOCK_MS.
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 60 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;

// PBKDF2 cost. The Workers Free plan allows ~10ms CPU per request, so this is
// tuned to stay inside that budget while still making offline cracking slow.
// Hashes store their own iteration count, so this can be raised later safely.
export const PBKDF2_ITERATIONS = 20_000;

export const MIN_PASSWORD_LENGTH = 4;

// ---- Encoding helpers -----------------------------------------------------------

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---- Password hashing (PBKDF2-SHA256 via WebCrypto) ----------------------------

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 1_000_000) return false;
  const expected = unb64(parts[3]);
  const actual = await pbkdf2(password, unb64(parts[2]), iterations);
  return constantTimeEqual(actual, expected);
}

const DUMMY_HASH = 'pbkdf2-sha256$20000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export function validateNewPassword(password: unknown): string {
  const p = str(password, 'Password', { max: 200, trim: false });
  if (p.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  return p;
}

export function validateUsername(username: unknown): string {
  const u = str(username, 'Username', { min: 1, max: 40 });
  if (!/^[A-Za-z0-9._@-]+$/.test(u)) {
    throw new HttpError(400, 'Username can only contain letters, numbers, dots, dashes, underscores and @');
  }
  return u;
}

// ---- Sessions ------------------------------------------------------------------

function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

async function createSession(env: Env, userId: string): Promise<string> {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(
      await sha256Hex(token),
      userId,
      now,
      now + SESSION_TTL_MS,
    ),
  ]);
  return token;
}

/** Resolves the logged-in user from the session cookie (or null). Renews long-lived sessions. */
export async function getSessionUser(env: Env, request: Request): Promise<{ user: AuthedUser; renewCookie?: string } | null> {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token || token.length > 100) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT s.expires_at, u.id, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
  )
    .bind(tokenHash)
    .first<{ expires_at: number; id: string; username: string; role: 'ADMIN' | 'MACHINIST' }>();
  const now = Date.now();
  if (!row || row.expires_at < now) return null;

  const user: AuthedUser = { id: row.id, username: row.username, role: row.role };
  if (row.expires_at - now < SESSION_TTL_MS - SESSION_RENEW_AFTER_MS) {
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').bind(now + SESSION_TTL_MS, tokenHash).run();
    return { user, renewCookie: sessionCookie(token, SESSION_TTL_MS / 1000) };
  }
  return { user };
}

// ---- Login throttling ----------------------------------------------------------

async function checkLock(env: Env, key: string): Promise<void> {
  const row = await env.DB.prepare('SELECT locked_until FROM login_attempts WHERE key = ?').bind(key).first<{ locked_until: number }>();
  if (row && row.locked_until > Date.now()) {
    const minutes = Math.ceil((row.locked_until - Date.now()) / 60000);
    throw new HttpError(429, `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
  }
}

async function recordFailure(env: Env, key: string): Promise<void> {
  const now = Date.now();
  const row = await env.DB.prepare('SELECT failures, window_start FROM login_attempts WHERE key = ?')
    .bind(key)
    .first<{ failures: number; window_start: number }>();
  let failures = 1;
  let windowStart = now;
  if (row && now - row.window_start < FAILURE_WINDOW_MS) {
    failures = row.failures + 1;
    windowStart = row.window_start;
  }
  const lockedUntil = failures >= MAX_FAILURES ? now + LOCK_MS : 0;
  if (lockedUntil) {
    failures = 0;
    windowStart = now;
  }
  await env.DB.prepare(
    `INSERT INTO login_attempts (key, failures, window_start, locked_until) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET failures = excluded.failures, window_start = excluded.window_start, locked_until = excluded.locked_until`,
  )
    .bind(key, failures, windowStart, lockedUntil)
    .run();
}

// ---- Route handlers ------------------------------------------------------------

async function hasAnyUser(env: Env): Promise<boolean> {
  return !!(await env.DB.prepare('SELECT 1 AS x FROM users LIMIT 1').first());
}

export async function handleMe(ctx: Ctx): Promise<Response> {
  if (ctx.user) return json({ user: ctx.user });
  return json({ user: null, needsSetup: !(await hasAnyUser(ctx.env)) });
}

export async function handleLogin(ctx: Ctx): Promise<Response> {
  const body = await readJson<{ username?: unknown; password?: unknown }>(ctx.request, 10_000);
  const username = str(body.username, 'Username', { min: 1, max: 100 });
  const password = str(body.password, 'Password', { min: 1, max: 200, trim: false });
  const key = username.toLowerCase();

  await checkLock(ctx.env, key);

  const row = await ctx.env.DB.prepare('SELECT id, username, role, password_hash FROM users WHERE username = ?')
    .bind(username)
    .first<{ id: string; username: string; role: 'ADMIN' | 'MACHINIST'; password_hash: string }>();

  // Always run one hash so response time does not reveal whether the user exists.
  const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !ok) {
    await recordFailure(ctx.env, key);
    throw new HttpError(401, 'Invalid username or password');
  }

  await ctx.env.DB.prepare('DELETE FROM login_attempts WHERE key = ?').bind(key).run();
  const token = await createSession(ctx.env, row.id);
  const user: AuthedUser = { id: row.id, username: row.username, role: row.role };
  return json(
    { user, weakPassword: row.role === 'ADMIN' && password.length < 8 },
    200,
    { 'Set-Cookie': sessionCookie(token, SESSION_TTL_MS / 1000) },
  );
}

export async function handleLogout(ctx: Ctx): Promise<Response> {
  const token = getCookie(ctx.request, SESSION_COOKIE);
  if (token) {
    await ctx.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  }
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
}

/** First-run only: creates the initial admin account when the database has no users. */
export async function handleSetup(ctx: Ctx): Promise<Response> {
  const body = await readJson<{ username?: unknown; password?: unknown }>(ctx.request, 10_000);
  const username = validateUsername(body.username);
  const password = validateNewPassword(body.password);
  if (await hasAnyUser(ctx.env)) throw new HttpError(409, 'Setup has already been completed. Please sign in.');

  const id = crypto.randomUUID();
  const hash = await hashPassword(password);
  // The NOT EXISTS guard makes this safe even if two setups race.
  const res = await ctx.env.DB.prepare(
    `INSERT INTO users (id, username, password_hash, role, created_at)
     SELECT ?, ?, ?, 'ADMIN', ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
  )
    .bind(id, username, hash, Date.now())
    .run();
  if (!res.meta.changes) throw new HttpError(409, 'Setup has already been completed. Please sign in.');

  await seedDefaultToolsIfEmpty(ctx.env, username);
  await bumpVersion(ctx.env, 'users');
  const token = await createSession(ctx.env, id);
  return json({ user: { id, username, role: 'ADMIN' } }, 200, { 'Set-Cookie': sessionCookie(token, SESSION_TTL_MS / 1000) });
}

export async function handleChangeOwnPassword(ctx: Ctx): Promise<Response> {
  const user = ctx.user!;
  const body = await readJson<{ currentPassword?: unknown; newPassword?: unknown }>(ctx.request, 10_000);
  const current = str(body.currentPassword, 'Current password', { min: 1, max: 200, trim: false });
  const next = validateNewPassword(body.newPassword);
  const row = await ctx.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id).first<{ password_hash: string }>();
  if (!row || !(await verifyPassword(current, row.password_hash))) {
    throw new HttpError(400, 'Current password is incorrect');
  }
  const hash = await hashPassword(next);
  const currentToken = getCookie(ctx.request, SESSION_COOKIE) ?? '';
  // Sign out every other device that was using the old password.
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, user.id),
    ctx.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(user.id, await sha256Hex(currentToken)),
  ]);
  return json({ ok: true });
}
