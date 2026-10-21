import type { RegionId } from '../src/regions';

export interface Env {
  /**
   * The database of the request's country (or of the master hub). The router sets it per request,
   * so every handler only ever sees the one database it is allowed to use.
   * In the raw Worker environment this is Morocco's database (the original installation).
   */
  DB: D1Database;
  /** Türkiye's database (raw environment only; handlers see it as DB). */
  DB_TR?: D1Database;
  /** Master hub database: master accounts and their sessions. */
  DB_HUB?: D1Database;
  ASSETS: Fetcher;
  /** Set by the router: which instance this request belongs to. */
  REGION?: RegionId | 'master';
  /** Set by the router for country requests: the hub database, only to recognise master sign-ins. */
  HUB?: D1Database;
  /** Set by the router for master requests only: every country's database, for the dashboard. */
  COUNTRIES?: Partial<Record<RegionId, D1Database>>;
  /**
   * Optional secret (set in Cloudflare: Settings -> Variables and Secrets).
   * When present, passwords are hashed as PBKDF2(HMAC(pepper, password)), so a copy of the
   * database alone is not enough to crack them. Never change or remove it once set.
   */
  AUTH_PEPPER?: string;
  /** Telegram bot token for alerts (Worker secret, from @BotFather). Alerts are off without it. */
  TELEGRAM_BOT_TOKEN?: string;
  /** Local testing only: a stand-in for api.telegram.org / api.callmebot.com. */
  TELEGRAM_API_BASE?: string;
  CALLMEBOT_API_BASE?: string;
}

export type Role = 'ADMIN' | 'MACHINIST';

export interface AuthedUser {
  id: string;
  username: string;
  role: Role;
}

export interface Ctx {
  env: Env;
  request: Request;
  url: URL;
  params: Record<string, string>;
  user: AuthedUser | null;
  /** Keeps work (alerts) running after the response is sent. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

export type SyncScope = 'tools' | 'history' | 'users' | 'settings' | 'parts' | 'machines';

/** Statement that bumps a sync version so other PCs know to refetch that data. */
export function bumpStmt(env: Env, scope: SyncScope): D1PreparedStatement {
  return env.DB.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').bind(`v_${scope}`);
}

export async function bumpVersion(env: Env, scope: SyncScope): Promise<void> {
  await bumpStmt(env, scope).run();
}

export async function readCounters(env: Env): Promise<Record<string, number>> {
  const { results } = await env.DB.prepare('SELECT name, value FROM counters').all<{ name: string; value: number }>();
  const out: Record<string, number> = {};
  for (const r of results) out[r.name] = r.value;
  return out;
}

export function newId(): string {
  return crypto.randomUUID();
}
