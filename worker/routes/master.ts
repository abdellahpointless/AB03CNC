import { HttpError, json, readJson } from '../http';
import { bumpVersion, newId, type Ctx, type Env } from '../context';
import { ensureSchema } from '../schema';
import { auditCtx, audit } from '../security';
import { hashPassword, masterEnvFrom, requirePassword, validateNewPassword, validateUsername } from '../auth';
import { DEFAULT_SAVED_SECONDS } from './analytics';
import { FEATURE_KEYS, readFeatures, writeFeatures } from '../features';
import { REGIONS, regionById, type RegionId } from '../../src/regions';

/*
 * Master hub. Master accounts live in their own database (DB_HUB). A master can read every
 * country's numbers side by side and create a country's admins, but never signs in to a country
 * as a user: the country apps only see their own database.
 */

function countryDb(env: Env, region: RegionId): D1Database | null {
  return env.COUNTRIES?.[region] ?? null;
}

async function openCountry(env: Env, region: RegionId): Promise<D1Database> {
  const db = countryDb(env, region);
  if (!db) throw new HttpError(503, 'This country is not connected yet.');
  await ensureSchema(db, region);
  return db;
}

function regionParam(ctx: Ctx): RegionId {
  const r = regionById(ctx.params.region);
  if (!r) throw new HttpError(404, 'Unknown country');
  return r.id;
}

const DAY = 86_400_000;
const PERIOD_DAYS: Record<string, number> = { DAILY: 1, WEEKLY: 7, MONTHLY: 30, QUARTERLY: 91 };

function isDue(c: { kind: string; frequency: string | null; last_done_at: number | null }, now: number): boolean {
  if (c.kind !== 'CHECK' || !c.frequency) return false;
  if (!c.last_done_at) return true;
  if (c.frequency === 'DAILY') {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    return c.last_done_at < start.getTime();
  }
  return now - c.last_done_at >= (PERIOD_DAYS[c.frequency] ?? 1) * DAY;
}

/** The last `n` months as YYYY-MM, oldest first. */
function lastMonths(n: number, now = new Date()): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

async function countryMetrics(db: D1Database, now: number) {
  const months = lastMonths(12, new Date(now));
  const since = Date.parse(`${months[0]}-01T00:00:00Z`);
  const [users, counters, saved, extractions, histMonthly, partsMonthly, pending, machines, checks, tools, top, last, recent, security] =
    await db.batch([
      db.prepare('SELECT role, COUNT(*) AS n, COALESCE(SUM(mfa_enabled), 0) AS mfa FROM users GROUP BY role'),
      db.prepare("SELECT name, value FROM counters WHERE name IN ('history_total', 'tools_app_selected', 'tools_manual')"),
      db.prepare("SELECT value FROM settings WHERE key = 'saved_seconds_per_extraction'"),
      db.prepare('SELECT COALESCE(SUM(extractions), 0) AS total FROM extraction_stats'),
      db.prepare(
        "SELECT strftime('%Y-%m', created_at / 1000, 'unixepoch') AS m, COUNT(*) AS n FROM history WHERE created_at >= ? GROUP BY m",
      ).bind(since),
      db.prepare(
        "SELECT month_key AS m, COALESCE(SUM(qty), 0) AS qty, COALESCE(SUM(qty * unit_value), 0) AS value FROM part_entries WHERE status = 'APPROVED' AND month_key >= ? GROUP BY month_key",
      ).bind(months[0]),
      db.prepare("SELECT COUNT(*) AS n FROM part_entries WHERE status = 'PENDING'"),
      db.prepare('SELECT id, name, has_tools FROM machines WHERE active = 1 ORDER BY sort, name'),
      db.prepare(
        'SELECT c.machine_id, c.kind, c.status, c.frequency, c.last_done_at FROM machine_checks c JOIN machines m ON m.id = c.machine_id AND m.active = 1',
      ),
      db.prepare("SELECT COUNT(*) AS n FROM tools t JOIN machines m ON m.id = t.machine AND m.active = 1 WHERE t.category != 'empty'"),
      db.prepare('SELECT username, extractions FROM extraction_stats ORDER BY extractions DESC LIMIT 5'),
      db.prepare('SELECT MAX(created_at) AS at FROM history'),
      db.prepare('SELECT COUNT(*) AS n FROM history WHERE created_at >= ?').bind(now - 30 * DAY),
      db.prepare(
        "SELECT action, COUNT(*) AS n, SUM(CASE WHEN detail LIKE '%locked%' THEN 1 ELSE 0 END) AS locks FROM audit_log WHERE at >= ? AND action IN ('login_failed', 'mfa_failed') GROUP BY action",
      ).bind(now - 7 * DAY),
    ]);

  const roles = users.results as { role: string; n: number; mfa: number }[];
  const admins = roles.find((r) => r.role === 'ADMIN');
  const counter = (name: string) => (counters.results as { name: string; value: number }[]).find((c) => c.name === name)?.value ?? 0;
  const savedSeconds = Number((saved.results[0] as { value?: string } | undefined)?.value) || DEFAULT_SAVED_SECONDS;
  const totalPrograms = (extractions.results[0] as { total: number }).total;
  const hist = new Map((histMonthly.results as { m: string; n: number }[]).map((r) => [r.m, r.n]));
  const parts = new Map((partsMonthly.results as { m: string; qty: number; value: number }[]).map((r) => [r.m, r]));

  const machineRows = machines.results as { id: string; name: string; has_tools: number }[];
  const checkRows = checks.results as { machine_id: string; kind: string; status: string; frequency: string | null; last_done_at: number | null }[];
  const perMachine = machineRows.map((m) => {
    const mine = checkRows.filter((c) => c.machine_id === m.id);
    const problems = mine.filter((c) => c.status === 'PROBLEM').length;
    const due = mine.filter((c) => c.status !== 'PROBLEM' && isDue(c, now)).length;
    return { id: m.id, name: m.name, problems, due };
  });
  const sec = security.results as { action: string; n: number; locks: number }[];
  const thisMonth = months[months.length - 1];

  return {
    configured: roles.length > 0,
    users: {
      admins: admins?.n ?? 0,
      machinists: roles.find((r) => r.role === 'MACHINIST')?.n ?? 0,
      adminsWithMfa: admins?.mfa ?? 0,
    },
    programs: {
      total: totalPrograms,
      last30Days: (recent.results[0] as { n: number }).n,
      appSelected: counter('tools_app_selected'),
      manual: counter('tools_manual'),
      savedSecondsPerProgram: savedSeconds,
      timeSavedSeconds: totalPrograms * savedSeconds,
      lastAt: (last.results[0] as { at: number | null }).at,
    },
    monthly: months.map((m) => ({ month: m, programs: hist.get(m) ?? 0, partsQty: parts.get(m)?.qty ?? 0, partsValue: parts.get(m)?.value ?? 0 })),
    parts: {
      pending: (pending.results[0] as { n: number }).n,
      thisMonthQty: parts.get(thisMonth)?.qty ?? 0,
      thisMonthValue: parts.get(thisMonth)?.value ?? 0,
    },
    machines: {
      total: machineRows.length,
      withTools: machineRows.filter((m) => m.has_tools).length,
      problems: perMachine.reduce((a, m) => a + m.problems, 0),
      dueChecks: perMachine.reduce((a, m) => a + m.due, 0),
      list: perMachine,
    },
    tools: { total: (tools.results[0] as { n: number }).n },
    topOperators: (top.results as { username: string; extractions: number }[]).map((r) => ({ username: r.username, programs: r.extractions })),
    security: {
      failedSignIns7d: sec.reduce((a, r) => a + r.n, 0),
      lockouts7d: sec.reduce((a, r) => a + (r.locks ?? 0), 0),
    },
  };
}

const OVERVIEW_CACHE_MS = 10 * 60_000;
const OVERVIEW_MIN_REFRESH_MS = 60_000;

// GET /master/api/overview[?fresh=1] -> every country's numbers, side by side.
// The result is cached in the hub for 10 minutes: computing it reads every country's history,
// and the free daily read quota is shared by the whole account. "fresh" recomputes, at most
// once a minute.
export async function handleMasterOverview(ctx: Ctx): Promise<Response> {
  const now = Date.now();
  const cached = await ctx.env.DB.prepare("SELECT value, updated_at FROM settings WHERE key = 'overview_cache'").first<{ value: string; updated_at: number }>();
  const age = cached ? now - cached.updated_at : Infinity;
  const wantFresh = ctx.url.searchParams.get('fresh') === '1';
  if (cached && (age < OVERVIEW_MIN_REFRESH_MS || (!wantFresh && age < OVERVIEW_CACHE_MS))) {
    return new Response(cached.value, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  const body = await computeOverview(ctx.env, now);
  await ctx.env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('overview_cache', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(body, now)
    .run();
  return new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function computeOverview(env: Env, now: number): Promise<string> {
  const countries = await Promise.all(
    REGIONS.map(async (r) => {
      const base = { id: r.id, name: r.name, nativeName: r.nativeName, language: r.language };
      const db = countryDb(env, r.id);
      if (!db) return { ...base, available: false as const };
      try {
        await ensureSchema(db, r.id);
        return { ...base, available: true as const, features: await readFeatures(db, r.id), ...(await countryMetrics(db, now)) };
      } catch (err) {
        console.error('master overview failed for', r.id, err instanceof Error ? err.message : err);
        return { ...base, available: false as const, error: 'This country could not be read right now.' };
      }
    }),
  );
  return JSON.stringify({ generatedAt: now, countries });
}

/** Forget the cached overview (after creating an admin, so the dashboard shows it at once). */
async function dropOverviewCache(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM settings WHERE key = 'overview_cache'").run();
}

// GET /master/api/countries/:region/admins
export async function handleCountryAdmins(ctx: Ctx): Promise<Response> {
  const region = regionParam(ctx);
  const db = await openCountry(ctx.env, region);
  const { results } = await db
    .prepare("SELECT id, username, created_at, mfa_enabled FROM users WHERE role = 'ADMIN' ORDER BY username COLLATE NOCASE")
    .all();
  return json({ admins: results });
}

/** A username may be used once across the hub and every country. */
async function assertUsernameFreeEverywhere(env: Env, username: string): Promise<void> {
  const inHub = await env.DB.prepare('SELECT 1 AS x FROM users WHERE username = ?').bind(username).first();
  if (inHub) throw new HttpError(409, 'This username is already used by a master account.');
  for (const r of REGIONS) {
    const db = countryDb(env, r.id);
    if (!db) continue;
    await ensureSchema(db, r.id);
    if (await db.prepare('SELECT 1 AS x FROM users WHERE username = ?').bind(username).first()) {
      throw new HttpError(409, `This username is already used in ${r.name}. Choose another one.`);
    }
  }
}

// POST /master/api/countries/:region/admins { username, password } -> a new admin in that country
export async function handleCreateCountryAdmin(ctx: Ctx): Promise<Response> {
  const region = regionParam(ctx);
  const db = await openCountry(ctx.env, region);
  const body = await readJson<{ username?: unknown; password?: unknown }>(ctx.request, 10_000);
  const username = validateUsername(body.username);
  const password = validateNewPassword(body.password, username, 'ADMIN');
  await assertUsernameFreeEverywhere(ctx.env, username);

  const id = newId();
  const now = Date.now();
  await db.batch([
    db.prepare(
      "INSERT INTO users (id, username, password_hash, role, created_at, password_changed_at) VALUES (?, ?, ?, 'ADMIN', ?, ?)",
    ).bind(id, username, await hashPassword(ctx.env, password), now, now),
    db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'v_users'"),
  ]);
  // Logged in both places: the hub (who did it) and the country (what appeared there).
  await dropOverviewCache(ctx.env);
  await auditCtx(ctx, 'master_created_admin', `${regionById(region)!.name}: ${username}`);
  await audit({ ...ctx.env, DB: db }, ctx.request, 'user_created', { id: null, username: `master:${ctx.user!.username}` }, `${username} (ADMIN)`);
  return json({ ok: true, user: { id, username, role: 'ADMIN' } });
}

// PUT /master/api/countries/:region/features { partTracking?, preventive?, shiftChecks?: boolean }
export async function handleSetCountryFeatures(ctx: Ctx): Promise<Response> {
  const region = regionParam(ctx);
  const db = await openCountry(ctx.env, region);
  const body = await readJson<Record<string, unknown>>(ctx.request, 2_000);
  const features = await readFeatures(db, region);
  const changes: string[] = [];
  for (const k of FEATURE_KEYS) {
    if (body[k] === undefined) continue;
    if (typeof body[k] !== 'boolean') throw new HttpError(400, 'Invalid value');
    if (features[k] !== body[k]) changes.push(`${k} ${body[k] ? 'on' : 'off'}`);
    features[k] = body[k] as boolean;
  }
  if (changes.length) {
    await writeFeatures(db, features);
    await dropOverviewCache(ctx.env);
    const summary = `${regionById(region)!.name}: ${changes.join(', ')}`;
    await auditCtx(ctx, 'master_features', summary);
    await audit({ ...ctx.env, DB: db }, ctx.request, 'features_changed', { id: null, username: `master:${ctx.user!.username}` }, changes.join(', '));
  }
  return json({ ok: true, features });
}

// GET /master/api/masters
export async function handleListMasters(ctx: Ctx): Promise<Response> {
  const { results } = await ctx.env.DB.prepare('SELECT id, username, created_at, mfa_enabled FROM users ORDER BY username COLLATE NOCASE').all();
  return json({ masters: results });
}

// POST /master/api/masters { username, password } -> another master account
export async function handleCreateMaster(ctx: Ctx): Promise<Response> {
  const body = await readJson<{ username?: unknown; password?: unknown; currentPassword?: unknown }>(ctx.request, 10_000);
  await requirePassword(ctx, body.currentPassword);
  const username = validateUsername(body.username);
  const password = validateNewPassword(body.password, username, 'ADMIN');
  await assertUsernameFreeEverywhere(ctx.env, username);
  const now = Date.now();
  await ctx.env.DB.prepare(
    "INSERT INTO users (id, username, password_hash, role, created_at, password_changed_at) VALUES (?, ?, ?, 'ADMIN', ?, ?)",
  )
    .bind(newId(), username, await hashPassword(ctx.env, password), now, now)
    .run();
  await auditCtx(ctx, 'master_created', username);
  return json({ ok: true });
}

// ---- Bootstrap from Morocco ----------------------------------------------------------

// Moroccan admin: GET /ma/api/admin/master-account -> { exists }
export async function handleMasterAccountStatus(ctx: Ctx): Promise<Response> {
  const hub = masterEnvFrom(ctx.env);
  if (!hub || ctx.env.REGION !== 'ma') return json({ available: false, exists: false });
  await ensureSchema(hub.DB, 'master');
  const row = await hub.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  return json({ available: true, exists: (row?.n ?? 0) > 0 });
}

// Moroccan admin: POST /ma/api/admin/master-account { username, password }
// Creates the very first master account. After that, only masters can add masters.
export async function handleCreateFirstMaster(ctx: Ctx): Promise<Response> {
  const hub = masterEnvFrom(ctx.env);
  if (!hub || ctx.env.REGION !== 'ma') throw new HttpError(404, 'Not found');
  await ensureSchema(hub.DB, 'master');
  const body = await readJson<{ username?: unknown; password?: unknown; currentPassword?: unknown }>(ctx.request, 10_000);
  // The master can read every country: the admin must confirm with their own password (an
  // unattended signed-in PC is not enough).
  await requirePassword(ctx, body.currentPassword);
  const username = validateUsername(body.username);
  const password = validateNewPassword(body.password, username, 'ADMIN');

  // Same rule as for every master: the name must not exist in any country. Only Morocco can have
  // accounts before the first master exists (other countries get their admins from a master).
  const fullHub: Env = { ...hub, COUNTRIES: Object.fromEntries(REGIONS.map((r) => [r.id, r.id === 'ma' ? ctx.env.DB : undefined])) };
  await assertUsernameFreeEverywhere(fullHub, username);
  const now = Date.now();
  const res = await hub.DB.prepare(
    `INSERT INTO users (id, username, password_hash, role, created_at, password_changed_at)
     SELECT ?, ?, ?, 'ADMIN', ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
  )
    .bind(newId(), username, await hashPassword(ctx.env, password), now, now)
    .run();
  if (!res.meta.changes) throw new HttpError(409, 'A master account already exists. Ask a master admin to add more.');
  await auditCtx(ctx, 'master_created', username);
  await audit(hub, ctx.request, 'master_created', { id: null, username: `ma-admin:${ctx.user!.username}` }, username);
  await bumpVersion(ctx.env, 'users');
  return json({ ok: true });
}

// DELETE /master/api/masters/:id -> remove another master account (never yourself or the last one)
export async function handleDeleteMaster(ctx: Ctx): Promise<Response> {
  const id = ctx.params.id;
  if (id === ctx.user!.id) throw new HttpError(400, 'You cannot delete your own account');
  const target = await ctx.env.DB.prepare('SELECT username FROM users WHERE id = ?').bind(id).first<{ username: string }>();
  if (!target) throw new HttpError(404, 'User not found');
  const res = await ctx.env.DB.prepare('DELETE FROM users WHERE id = ? AND (SELECT COUNT(*) FROM users) > 1').bind(id).run();
  if (!res.meta.changes) throw new HttpError(400, 'At least one master account must remain');
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
    ctx.env.DB.prepare('DELETE FROM login_challenges WHERE user_id = ?').bind(id),
  ]);
  await auditCtx(ctx, 'master_deleted', target.username);
  return json({ ok: true });
}
