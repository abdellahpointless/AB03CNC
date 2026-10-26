import { HttpError, json, num, readJson } from '../http';
import { bumpStmt, readCounters, type Ctx, type Env } from '../context';

export const DEFAULT_SAVED_SECONDS = 285; // 5.5 min manual - 45 s with the app

export async function getSavedSeconds(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'saved_seconds_per_extraction'").first<{ value: string }>();
  const n = row ? parseInt(row.value, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SAVED_SECONDS;
}

/** Accounts the admin hid from the statistics (test accounts that cannot be deleted), lower case. */
export async function getHiddenUsers(env: Env): Promise<string[]> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'stats_hidden_users'").first<{ value: string }>();
  try {
    const v = JSON.parse(row?.value ?? '[]');
    return Array.isArray(v) ? v.filter((u): u is string => typeof u === 'string') : [];
  } catch {
    return [];
  }
}

// GET /api/analytics  -> time-won numbers (any signed-in user; per-user list only for admins)
// Hidden accounts count nowhere (totals included); admins still get them in the list, marked hidden.
export async function handleAnalytics(ctx: Ctx): Promise<Response> {
  const [savedSeconds, counters, stats, hidden] = await Promise.all([
    getSavedSeconds(ctx.env),
    readCounters(ctx.env),
    ctx.env.DB.prepare('SELECT username, extractions, last_at FROM extraction_stats ORDER BY extractions DESC').all<{
      username: string;
      extractions: number;
      last_at: number | null;
    }>(),
    getHiddenUsers(ctx.env),
  ]);
  const isHidden = (u: string) => hidden.includes(u.toLowerCase());
  const shown = stats.results.filter((r) => !isHidden(r.username));
  const totalExtractions = shown.reduce((acc, r) => acc + r.extractions, 0);
  const isAdmin = ctx.user!.role === 'ADMIN';
  return json({
    savedSecondsPerExtraction: savedSeconds,
    totalExtractions,
    totalTimeSavedSeconds: totalExtractions * savedSeconds,
    contributingUsers: shown.length,
    appSelected: counters.tools_app_selected ?? 0,
    manualChanged: counters.tools_manual ?? 0,
    hiddenUsers: isAdmin ? hidden : [],
    users: isAdmin
      ? stats.results.map((r) => ({
          username: r.username,
          extractions: r.extractions,
          timeSavedSeconds: r.extractions * savedSeconds,
          lastExtractedAt: r.last_at,
          hidden: isHidden(r.username),
        }))
      : [],
  });
}

// PUT /api/settings/saved-seconds { seconds }  (admin)
export async function handleSetSavedSeconds(ctx: Ctx): Promise<Response> {
  const body = await readJson<{ seconds?: unknown }>(ctx.request, 1000);
  const seconds = num(body.seconds, 'seconds', { min: 1, max: 3600, integer: true });
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('saved_seconds_per_extraction', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(String(seconds), Date.now()),
    bumpStmt(ctx.env, 'settings'),
  ]);
  return json({ ok: true, seconds });
}

// PUT /api/settings/hidden-users { usernames: string[] }  (admin)
export async function handleSetHiddenUsers(ctx: Ctx): Promise<Response> {
  const body = await readJson<{ usernames?: unknown }>(ctx.request, 20_000);
  if (!Array.isArray(body.usernames) || body.usernames.length > 500) throw new HttpError(400, 'Invalid list of users');
  const list = [...new Set(body.usernames.map((u) => String(u).trim().toLowerCase()).filter((u) => u && u.length <= 64))];
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('stats_hidden_users', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(JSON.stringify(list), Date.now()),
    bumpStmt(ctx.env, 'settings'),
  ]);
  return json({ ok: true, usernames: list });
}

// GET /api/sync  -> cheap version check used by every open screen (~8 rows read)
export async function handleSync(ctx: Ctx): Promise<Response> {
  const counters = await readCounters(ctx.env);
  return json({
    user: ctx.user,
    serverTime: Date.now(),
    versions: {
      tools: counters.v_tools ?? 0,
      history: counters.v_history ?? 0,
      users: counters.v_users ?? 0,
      settings: counters.v_settings ?? 0,
      parts: counters.v_parts ?? 0,
      machines: counters.v_machines ?? 0,
    },
  });
}
