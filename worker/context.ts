export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /**
   * Optional secret (set in Cloudflare: Settings -> Variables and Secrets).
   * When present, passwords are hashed as PBKDF2(HMAC(pepper, password)), so a copy of the
   * database alone is not enough to crack them. Never change or remove it once set.
   */
  AUTH_PEPPER?: string;
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
