import { HttpError, getCookie, json, readJson, str } from './http';
import { bumpVersion, type Ctx, type AuthedUser, type Env, type Role } from './context';
import { seedDefaultToolsIfEmpty } from './routes/tools';
import {
  audit,
  auditCtx,
  b64,
  b64url,
  clientIp,
  constantTimeEqual,
  newRecoveryCodes,
  newTotpSecret,
  normalizeRecoveryCode,
  otpauthUrl,
  passwordProblem,
  sha256Hex,
  unb64,
  verifyTotp,
} from './security';

// `__Host-` cookies must be Secure, Path=/ and have no Domain: they cannot be set or
// overwritten by a sub-domain or a plain-HTTP page. The old name is still read once so
// people already signed in are moved over silently.
export const SESSION_COOKIE = '__Host-cnc_sid';
const LEGACY_SESSION_COOKIE = 'cnc_sid';

// Session lifetimes. Machinists stay signed in on shop-floor PCs (sliding 30 days, at most
// 60 days in total). Admin sessions end after 12 hours without activity and after 7 days in
// any case (the admin PC's 10-minute backup keeps an attended session alive).
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const LIFETIME = {
  MACHINIST: { idle: 30 * DAY, renewBelow: 15 * DAY, max: 60 * DAY },
  ADMIN: { idle: 12 * HOUR, renewBelow: 6 * HOUR, max: 7 * DAY },
} as const;

// Login throttling. Per account: 10 failures in an hour lock it for 15 minutes.
// Per IP: 40 attempts on usernames that do not exist (guessing / spraying) lock that address.
// Wrong passwords for real accounts only count against that account, so one person on the
// shared shop-floor IP cannot lock everybody else out.
const FAILURE_WINDOW_MS = 60 * 60 * 1000;
const LIMITS = {
  user: { max: 10, lockMs: 15 * 60 * 1000 },
  ip: { max: 40, lockMs: 15 * 60 * 1000 },
  pw: { max: 5, lockMs: 15 * 60 * 1000 },
} as const;

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_MAX_ATTEMPTS = 5;

// PBKDF2 cost. The Workers Free plan allows ~10ms CPU per request, so this is
// tuned to stay inside that budget while still making offline cracking slow.
// Hashes store their own iteration count, so this can be raised later safely.
export const PBKDF2_ITERATIONS = 20_000;

// ---- Password hashing (PBKDF2-SHA256 via WebCrypto, optional HMAC pepper) ---------------

async function pepperBytes(env: Env, password: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.AUTH_PEPPER!), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(password)));
}

async function pbkdf2(input: Uint8Array, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', input, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

function hasPepper(env: Env): boolean {
  if (typeof env.AUTH_PEPPER !== 'string' || !env.AUTH_PEPPER) return false;
  if (env.AUTH_PEPPER.length < 16) {
    console.error('AUTH_PEPPER is set but shorter than 16 characters; it is ignored');
    return false;
  }
  return true;
}

export async function hashPassword(env: Env, password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  if (hasPepper(env)) {
    const hash = await pbkdf2(await pepperBytes(env, password), salt, iterations);
    return `pbkdf2-sha256-p$${iterations}$${b64(salt)}$${b64(hash)}`;
  }
  const hash = await pbkdf2(new TextEncoder().encode(password), salt, iterations);
  return `pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(env: Env, password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4) return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 1_000_000) return false;
  let input: Uint8Array;
  if (parts[0] === 'pbkdf2-sha256') input = new TextEncoder().encode(password);
  else if (parts[0] === 'pbkdf2-sha256-p') {
    if (!hasPepper(env)) {
      console.error('A peppered password hash exists but AUTH_PEPPER is not set');
      return false;
    }
    input = await pepperBytes(env, password);
  } else return false;
  const expected = unb64(parts[3]);
  const actual = await pbkdf2(input, unb64(parts[2]), iterations);
  return constantTimeEqual(actual, expected);
}

/** True when a stored hash should be upgraded (pepper now available, or a higher cost). */
function needsRehash(env: Env, stored: string): boolean {
  const [scheme, iter] = stored.split('$');
  if (Number(iter) < PBKDF2_ITERATIONS) return true;
  return hasPepper(env) && scheme !== 'pbkdf2-sha256-p';
}

const DUMMY_HASH = 'pbkdf2-sha256$20000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** Validates a new password against the policy for the account it is meant for. */
export function validateNewPassword(password: unknown, username: string, role: Role): string {
  const p = str(password, 'Password', { max: 200, trim: false });
  const problem = passwordProblem(p, username, role);
  if (problem) throw new HttpError(400, problem);
  return p;
}

export function validateUsername(username: unknown): string {
  const u = str(username, 'Username', { min: 1, max: 40 });
  if (!/^[A-Za-z0-9._@-]+$/.test(u)) {
    throw new HttpError(400, 'Username can only contain letters, numbers, dots, dashes, underscores and @');
  }
  return u;
}

async function recoveryHash(env: Env, code: string): Promise<string> {
  return sha256Hex(`${hasPepper(env) ? env.AUTH_PEPPER : ''}|recovery|${normalizeRecoveryCode(code)}`);
}

/** Both forms a stored recovery code may have (before and after a pepper was configured). */
async function recoveryHashCandidates(env: Env, code: string): Promise<string[]> {
  const plain = await sha256Hex(`|recovery|${normalizeRecoveryCode(code)}`);
  return hasPepper(env) ? [await recoveryHash(env, code), plain] : [plain];
}

// ---- Sessions ------------------------------------------------------------------

function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

function clearCookies(): string[] {
  return [sessionCookie('', 0), `${LEGACY_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`];
}

function readToken(request: Request): { token: string; legacy: boolean } | null {
  const t = getCookie(request, SESSION_COOKIE);
  if (t) return { token: t, legacy: false };
  const legacy = getCookie(request, LEGACY_SESSION_COOKIE);
  return legacy ? { token: legacy, legacy: true } : null;
}


async function createSession(env: Env, userId: string, role: Role): Promise<{ token: string; cookie: string }> {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  const ttl = LIFETIME[role].idle;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM login_challenges WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM login_attempts WHERE locked_until < ? AND window_start < ?').bind(now, now - FAILURE_WINDOW_MS),
    env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(now - 2 * DAY),
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, role) VALUES (?, ?, ?, ?, ?)').bind(
      await sha256Hex(token),
      userId,
      now,
      now + ttl,
      role,
    ),
  ]);
  return { token, cookie: sessionCookie(token, Math.floor(ttl / 1000)) };
}

/**
 * Resolves the logged-in user from the session cookie (or null). Sessions are invalid when
 * they expired, passed their absolute limit, or were created for a different role.
 */
export async function getSessionUser(env: Env, request: Request): Promise<{ user: AuthedUser; setCookies: string[] } | null> {
  const found = readToken(request);
  if (!found || found.token.length > 100) return null;
  const tokenHash = await sha256Hex(found.token);
  const row = await env.DB.prepare(
    `SELECT s.created_at, s.expires_at, s.role AS session_role, u.id, u.username, u.role,
            (SELECT applied_at FROM schema_migrations WHERE version = 3) AS hardened_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
  )
    .bind(tokenHash)
    .first<{
      created_at: number;
      expires_at: number;
      session_role: Role | null;
      id: string;
      username: string;
      role: Role;
      hardened_at: number | null;
    }>();
  const now = Date.now();
  if (!row) return null;
  // The old cookie name is only honoured for sessions that existed before this version went
  // live; anything newer must arrive in the __Host- cookie.
  if (found.legacy && row.hardened_at !== null && row.created_at >= row.hardened_at) return null;
  const life = LIFETIME[row.role];
  const roleChanged = row.session_role !== null && row.session_role !== row.role;
  if (row.expires_at < now || now - row.created_at > life.max || roleChanged) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }

  const user: AuthedUser = { id: row.id, username: row.username, role: row.role };
  const setCookies: string[] = [];
  let expiresAt = Math.min(row.expires_at, row.created_at + life.max);
  if (expiresAt - now < life.renewBelow && row.created_at + life.max > now + life.renewBelow) {
    expiresAt = Math.min(now + life.idle, row.created_at + life.max);
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').bind(expiresAt, tokenHash).run();
    setCookies.push(sessionCookie(found.token, Math.floor((expiresAt - now) / 1000)));
  } else if (found.legacy) {
    setCookies.push(sessionCookie(found.token, Math.max(0, Math.floor((expiresAt - now) / 1000))));
  }
  if (found.legacy) setCookies.push(clearCookies()[1]);
  return { user, setCookies };
}

// ---- Throttling ----------------------------------------------------------------

type LimitKind = keyof typeof LIMITS;

async function isLocked(env: Env, key: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT locked_until FROM login_attempts WHERE key = ?').bind(key).first<{ locked_until: number }>();
  return !!row && row.locked_until > Date.now();
}

async function checkLock(env: Env, key: string): Promise<void> {
  const row = await env.DB.prepare('SELECT locked_until FROM login_attempts WHERE key = ?').bind(key).first<{ locked_until: number }>();
  if (row && row.locked_until > Date.now()) {
    const minutes = Math.ceil((row.locked_until - Date.now()) / 60000);
    throw new HttpError(429, `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
  }
}

/**
 * Records one failure in a single atomic statement (parallel requests cannot all read the same
 * count) and returns true when this failure triggered a lock.
 */
async function recordFailure(env: Env, key: string, kind: LimitKind): Promise<boolean> {
  const { max, lockMs } = LIMITS[kind];
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO login_attempts (key, failures, window_start, locked_until) VALUES (?1, 1, ?2, 0)
     ON CONFLICT(key) DO UPDATE SET
       failures = CASE WHEN window_start < ?3 THEN 1 ELSE failures + 1 END,
       window_start = CASE WHEN window_start < ?3 THEN ?2 ELSE window_start END
     RETURNING failures`,
  )
    .bind(key, now, now - FAILURE_WINDOW_MS)
    .first<{ failures: number }>();
  if ((row?.failures ?? 0) < max) return false;
  await env.DB.prepare('UPDATE login_attempts SET failures = 0, window_start = ?, locked_until = ? WHERE key = ?')
    .bind(now, now + lockMs, key)
    .run();
  return true;
}

const userKey = (username: string) => `u:${username.toLowerCase()}`;
/** IPv6 clients usually own a whole /64, so they are limited per /64 rather than per address. */
function ipKey(request: Request): string {
  const ip = clientIp(request);
  if (ip.includes(':')) {
    const parts = ip.split('::')[0].split(':');
    return `ip:${parts.slice(0, 4).join(':')}::/64`;
  }
  return `ip:${ip}`;
}

/** Lets a signed-in user prove they know their password (for sensitive actions), with throttling. */
async function requirePassword(ctx: Ctx, password: unknown): Promise<void> {
  const user = ctx.user!;
  const key = `pw:${user.id}`;
  await checkLock(ctx.env, key);
  const p = str(password, 'Current password', { min: 1, max: 200, trim: false });
  const row = await ctx.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id).first<{ password_hash: string }>();
  if (!row || !(await verifyPassword(ctx.env, p, row.password_hash))) {
    const locked = await recordFailure(ctx.env, key, 'pw');
    await auditCtx(ctx, 'password_check_failed', locked ? 'locked' : undefined);
    throw new HttpError(400, 'Current password is incorrect');
  }
  await ctx.env.DB.prepare('DELETE FROM login_attempts WHERE key = ?').bind(key).run();
}

// ---- Route handlers ------------------------------------------------------------

async function hasAnyUser(env: Env): Promise<boolean> {
  return !!(await env.DB.prepare('SELECT 1 AS x FROM users LIMIT 1').first());
}

export async function handleMe(ctx: Ctx): Promise<Response> {
  if (ctx.user) {
    const row = await ctx.env.DB.prepare('SELECT mfa_enabled FROM users WHERE id = ?').bind(ctx.user.id).first<{ mfa_enabled: number }>();
    return json({ user: ctx.user, mfaEnabled: !!row?.mfa_enabled });
  }
  return json({ user: null, needsSetup: !(await hasAnyUser(ctx.env)) });
}

interface LoginRow {
  id: string;
  username: string;
  role: Role;
  password_hash: string;
  mfa_enabled: number;
}

async function finishLogin(ctx: Ctx, row: LoginRow, weakPassword: boolean, method: string): Promise<Response> {
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('DELETE FROM login_attempts WHERE key = ?').bind(userKey(row.username)),
  ]);
  const { cookie } = await createSession(ctx.env, row.id, row.role);
  await audit(ctx.env, ctx.request, 'login', row, method);
  const user: AuthedUser = { id: row.id, username: row.username, role: row.role };
  const res = json({ user, weakPassword, mfaEnabled: !!row.mfa_enabled });
  res.headers.append('Set-Cookie', cookie);
  if (getCookie(ctx.request, LEGACY_SESSION_COOKIE)) res.headers.append('Set-Cookie', clearCookies()[1]);
  return res;
}

export async function handleLogin(ctx: Ctx): Promise<Response> {
  const body = await readJson<{ username?: unknown; password?: unknown }>(ctx.request, 10_000);
  const username = str(body.username, 'Username', { min: 1, max: 100 });
  const password = str(body.password, 'Password', { min: 1, max: 200, trim: false });
  const uKey = userKey(username);
  const iKey = ipKey(ctx.request);

  // A locked IP is not refused outright (the whole shop shares one IP); it only stops being
  // recorded, so a flood of made-up usernames cannot burn the database's daily write quota.
  const ipLocked = await isLocked(ctx.env, iKey);
  await checkLock(ctx.env, uKey);

  const row = await ctx.env.DB.prepare('SELECT id, username, role, password_hash, mfa_enabled FROM users WHERE username = ?')
    .bind(username)
    .first<LoginRow>();

  // Always run one hash so response time does not reveal whether the user exists.
  const ok = await verifyPassword(ctx.env, password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !ok) {
    // Real accounts: counted per account. Unknown names: counted per IP (guessing/spraying), and
    // the typed name is not stored (people sometimes type their password in the username box).
    if (row || !ipLocked) {
      const locked = row ? await recordFailure(ctx.env, uKey, 'user') : await recordFailure(ctx.env, iKey, 'ip');
      await audit(
        ctx.env,
        ctx.request,
        'login_failed',
        row ?? { username: '(unknown user)' },
        locked ? (row ? 'account locked' : 'IP throttled (unknown usernames)') : undefined,
      );
    }
    throw new HttpError(401, 'Invalid username or password');
  }

  if (needsRehash(ctx.env, row.password_hash)) {
    await ctx.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(ctx.env, password), row.id).run();
  }
  const weakPassword = passwordProblem(password, row.username, row.role) !== null;

  if (row.mfa_enabled) {
    const challenge = b64url(crypto.getRandomValues(new Uint8Array(32)));
    await ctx.env.DB.prepare('INSERT INTO login_challenges (token_hash, user_id, expires_at, attempts) VALUES (?, ?, ?, 0)')
      .bind(await sha256Hex(challenge), row.id, Date.now() + CHALLENGE_TTL_MS)
      .run();
    return json({ mfaRequired: true, challenge, weakPassword });
  }
  return finishLogin(ctx, row, weakPassword, 'password');
}

/** Second sign-in step: a 6-digit authenticator code or a one-time recovery code. */
export async function handleMfaVerify(ctx: Ctx): Promise<Response> {
  const body = await readJson<{ challenge?: unknown; code?: unknown; weakPassword?: unknown }>(ctx.request, 5_000);
  const challenge = str(body.challenge, 'Challenge', { min: 10, max: 100 });
  const code = str(body.code, 'Code', { min: 6, max: 20 });

  const challengeHash = await sha256Hex(challenge);
  // Take one attempt atomically *before* checking the code, so parallel guesses cannot all slip
  // under the limit.
  const ch = await ctx.env.DB.prepare(
    `UPDATE login_challenges SET attempts = attempts + 1
     WHERE token_hash = ? AND attempts < ? AND expires_at > ? RETURNING user_id`,
  )
    .bind(challengeHash, CHALLENGE_MAX_ATTEMPTS, Date.now())
    .first<{ user_id: string }>();
  if (!ch) {
    throw new HttpError(401, 'Sign-in expired. Please enter your password again.');
  }
  const row = await ctx.env.DB.prepare(
    'SELECT id, username, role, password_hash, mfa_enabled, mfa_secret, mfa_last_step, mfa_recovery FROM users WHERE id = ?',
  )
    .bind(ch.user_id)
    .first<LoginRow & { mfa_secret: string | null; mfa_last_step: number; mfa_recovery: string | null }>();
  if (!row || !row.mfa_enabled) throw new HttpError(401, 'Sign-in expired. Please enter your password again.');
  await checkLock(ctx.env, userKey(row.username));

  let method = 'totp';
  let accepted = false;
  if (/^\d{6}$/.test(code.replace(/\s/g, ''))) {
    const step = row.mfa_secret ? await verifyTotp(row.mfa_secret, code.replace(/\s/g, ''), row.mfa_last_step) : null;
    if (step !== null) {
      // Conditional update: the same code can never be used twice, even by two parallel requests.
      const res = await ctx.env.DB.prepare('UPDATE users SET mfa_last_step = ? WHERE id = ? AND mfa_last_step < ?').bind(step, row.id, step).run();
      accepted = res.meta.changes === 1;
    }
  } else {
    method = 'recovery code';
    const hashes: string[] = row.mfa_recovery ? JSON.parse(row.mfa_recovery) : [];
    const h = (await recoveryHashCandidates(ctx.env, code)).find((x) => hashes.includes(x));
    if (h) {
      const remaining = JSON.stringify(hashes.filter((x) => x !== h));
      const res = await ctx.env.DB.prepare('UPDATE users SET mfa_recovery = ? WHERE id = ? AND mfa_recovery = ?')
        .bind(remaining, row.id, row.mfa_recovery)
        .run();
      accepted = res.meta.changes === 1;
    }
  }

  if (!accepted) {
    const locked = await recordFailure(ctx.env, userKey(row.username), 'user');
    await audit(ctx.env, ctx.request, 'mfa_failed', row, locked ? 'account locked' : undefined);
    throw new HttpError(401, 'Wrong code. Check the time on your phone and try again.');
  }
  await ctx.env.DB.prepare('DELETE FROM login_challenges WHERE token_hash = ?').bind(challengeHash).run();
  return finishLogin(ctx, row, body.weakPassword === true, method);
}

export async function handleLogout(ctx: Ctx): Promise<Response> {
  const found = readToken(ctx.request);
  if (found) {
    await ctx.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(found.token)).run();
  }
  const res = json({ ok: true });
  for (const c of clearCookies()) res.headers.append('Set-Cookie', c);
  return res;
}

/** First-run only: creates the initial admin account when the database has no users. */
export async function handleSetup(ctx: Ctx): Promise<Response> {
  const body = await readJson<{ username?: unknown; password?: unknown }>(ctx.request, 10_000);
  const username = validateUsername(body.username);
  const password = validateNewPassword(body.password, username, 'ADMIN');
  if (await hasAnyUser(ctx.env)) throw new HttpError(409, 'Setup has already been completed. Please sign in.');

  const id = crypto.randomUUID();
  const hash = await hashPassword(ctx.env, password);
  // The NOT EXISTS guard makes this safe even if two setups race.
  const res = await ctx.env.DB.prepare(
    `INSERT INTO users (id, username, password_hash, role, created_at, password_changed_at)
     SELECT ?, ?, ?, 'ADMIN', ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
  )
    .bind(id, username, hash, Date.now(), Date.now())
    .run();
  if (!res.meta.changes) throw new HttpError(409, 'Setup has already been completed. Please sign in.');

  await seedDefaultToolsIfEmpty(ctx.env, username);
  await bumpVersion(ctx.env, 'users');
  const { cookie } = await createSession(ctx.env, id, 'ADMIN');
  await audit(ctx.env, ctx.request, 'setup', { id, username });
  return json({ user: { id, username, role: 'ADMIN' }, mfaEnabled: false }, 200, { 'Set-Cookie': cookie });
}

export async function handleChangeOwnPassword(ctx: Ctx): Promise<Response> {
  const user = ctx.user!;
  const body = await readJson<{ currentPassword?: unknown; newPassword?: unknown }>(ctx.request, 10_000);
  await requirePassword(ctx, body.currentPassword);
  const next = validateNewPassword(body.newPassword, user.username, user.role);
  if (next === body.currentPassword) throw new HttpError(400, 'The new password must be different from the current one.');
  const hash = await hashPassword(ctx.env, next);
  const currentToken = readToken(ctx.request)?.token ?? '';
  // Sign out every other device that was using the old password.
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?').bind(hash, Date.now(), user.id),
    ctx.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(user.id, await sha256Hex(currentToken)),
    ctx.env.DB.prepare('DELETE FROM login_challenges WHERE user_id = ?').bind(user.id),
  ]);
  await auditCtx(ctx, 'password_changed');
  return json({ ok: true });
}

// ---- Two-step sign-in management (signed-in user) --------------------------------------

// POST /auth/mfa/setup -> a new secret to scan; it only becomes active after /enable.
export async function handleMfaSetup(ctx: Ctx): Promise<Response> {
  const user = ctx.user!;
  const row = await ctx.env.DB.prepare('SELECT mfa_enabled FROM users WHERE id = ?').bind(user.id).first<{ mfa_enabled: number }>();
  if (row?.mfa_enabled) throw new HttpError(409, 'Two-step sign-in is already on.');
  const secret = newTotpSecret();
  await ctx.env.DB.prepare('UPDATE users SET mfa_pending_secret = ? WHERE id = ?').bind(secret, user.id).run();
  return json({ secret, otpauth: otpauthUrl(secret, user.username) });
}

// POST /auth/mfa/enable { password, code } -> turns it on and returns 10 recovery codes (shown once).
export async function handleMfaEnable(ctx: Ctx): Promise<Response> {
  const user = ctx.user!;
  const body = await readJson<{ password?: unknown; code?: unknown }>(ctx.request, 5_000);
  await requirePassword(ctx, body.password);
  const code = str(body.code, 'Code', { min: 6, max: 10 }).replace(/\s/g, '');
  const row = await ctx.env.DB.prepare('SELECT mfa_pending_secret, mfa_enabled FROM users WHERE id = ?')
    .bind(user.id)
    .first<{ mfa_pending_secret: string | null; mfa_enabled: number }>();
  if (row?.mfa_enabled) throw new HttpError(409, 'Two-step sign-in is already on.');
  if (!row?.mfa_pending_secret) throw new HttpError(400, 'Start the setup again.');
  const step = await verifyTotp(row.mfa_pending_secret, code, 0);
  if (step === null) throw new HttpError(400, 'Wrong code. Check the time on your phone and try again.');

  const codes = newRecoveryCodes();
  const hashes = await Promise.all(codes.map((c) => recoveryHash(ctx.env, c)));
  const currentToken = readToken(ctx.request)?.token ?? '';
  const [updated] = await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `UPDATE users SET mfa_secret = ?1, mfa_pending_secret = NULL, mfa_enabled = 1, mfa_recovery = ?2, mfa_last_step = ?3
       WHERE id = ?4 AND mfa_enabled = 0 AND mfa_pending_secret = ?1`,
    ).bind(row.mfa_pending_secret, JSON.stringify(hashes), step, user.id),
    // Other devices must sign in again with the second step.
    ctx.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(user.id, await sha256Hex(currentToken)),
    ctx.env.DB.prepare("UPDATE counters SET value = value + 1 WHERE name = 'v_users'"),
  ]);
  if (updated.meta.changes !== 1) throw new HttpError(409, 'The setup changed in another window. Start again.');
  await auditCtx(ctx, 'mfa_enabled');
  return json({ ok: true, recoveryCodes: codes });
}

// POST /auth/mfa/disable { password, code }
export async function handleMfaDisable(ctx: Ctx): Promise<Response> {
  const user = ctx.user!;
  const body = await readJson<{ password?: unknown; code?: unknown }>(ctx.request, 5_000);
  await requirePassword(ctx, body.password);
  const code = str(body.code, 'Code', { min: 6, max: 20 }).replace(/\s/g, '');
  const row = await ctx.env.DB.prepare('SELECT mfa_secret, mfa_last_step, mfa_recovery, mfa_enabled FROM users WHERE id = ?')
    .bind(user.id)
    .first<{ mfa_secret: string | null; mfa_last_step: number; mfa_recovery: string | null; mfa_enabled: number }>();
  if (!row?.mfa_enabled || !row.mfa_secret) throw new HttpError(400, 'Two-step sign-in is not on.');
  let ok = (await verifyTotp(row.mfa_secret, code, row.mfa_last_step)) !== null;
  if (!ok) {
    const hashes: string[] = row.mfa_recovery ? JSON.parse(row.mfa_recovery) : [];
    ok = (await recoveryHashCandidates(ctx.env, code)).some((h) => hashes.includes(h));
  }
  if (!ok) {
    await recordFailure(ctx.env, `pw:${user.id}`, 'pw');
    throw new HttpError(400, 'Wrong code.');
  }
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      'UPDATE users SET mfa_secret = NULL, mfa_pending_secret = NULL, mfa_enabled = 0, mfa_recovery = NULL WHERE id = ?',
    ).bind(user.id),
    ctx.env.DB.prepare("UPDATE counters SET value = value + 1 WHERE name = 'v_users'"),
  ]);
  await auditCtx(ctx, 'mfa_disabled');
  return json({ ok: true });
}

// Admin: GET /admin/audit -> the latest security events
export async function handleAuditLog(ctx: Ctx): Promise<Response> {
  const { results } = await ctx.env.DB.prepare(
    'SELECT id, at, username, ip, action, detail FROM audit_log ORDER BY at DESC, id DESC LIMIT 300',
  ).all();
  return json({ events: results });
}
