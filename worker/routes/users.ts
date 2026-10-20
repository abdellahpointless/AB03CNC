import { HttpError, json, readJson } from '../http';
import { bumpStmt, newId, type Ctx, type Role } from '../context';
import { hashPassword, validateNewPassword, validateUsername } from '../auth';
import { auditCtx } from '../security';

function parseRole(v: unknown): Role {
  if (v === 'ADMIN' || v === 'MACHINIST') return v;
  throw new HttpError(400, 'Role must be ADMIN or MACHINIST');
}

// Guard used inside UPDATE/DELETE so "at least one admin" holds even when two admins act at once.
const KEEPS_AN_ADMIN = "(role != 'ADMIN' OR (SELECT COUNT(*) FROM users WHERE role = 'ADMIN') > 1)";

// GET /api/users  (admin)
export async function handleListUsers(ctx: Ctx): Promise<Response> {
  const { results } = await ctx.env.DB.prepare(
    'SELECT id, username, role, created_at, mfa_enabled FROM users ORDER BY role, username COLLATE NOCASE',
  ).all();
  return json({ users: results });
}

// POST /api/users { username, password, role }  (admin)
export async function handleCreateUser(ctx: Ctx): Promise<Response> {
  const body = await readJson<{ username?: unknown; password?: unknown; role?: unknown }>(ctx.request, 10_000);
  const username = validateUsername(body.username);
  const role = parseRole(body.role ?? 'MACHINIST');
  const password = validateNewPassword(body.password, username, role);

  const exists = await ctx.env.DB.prepare('SELECT 1 AS x FROM users WHERE username = ? COLLATE NOCASE').bind(username).first();
  if (exists) throw new HttpError(409, 'User already exists');

  const id = newId();
  const now = Date.now();
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      'INSERT INTO users (id, username, password_hash, role, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(id, username, await hashPassword(ctx.env, password), role, now, now),
    bumpStmt(ctx.env, 'users'),
  ]);
  await auditCtx(ctx, 'user_created', `${username} (${role})`);
  return json({ user: { id, username, role } });
}

// PATCH /api/users/:id { password?, role?, resetMfa? }  (admin)
export async function handleUpdateUser(ctx: Ctx): Promise<Response> {
  const id = ctx.params.id;
  const body = await readJson<{ password?: unknown; role?: unknown; resetMfa?: unknown }>(ctx.request, 10_000);
  const target = await ctx.env.DB.prepare('SELECT id, username, role FROM users WHERE id = ?')
    .bind(id)
    .first<{ id: string; username: string; role: Role }>();
  if (!target) throw new HttpError(404, 'User not found');
  const self = id === ctx.user!.id;
  const db = ctx.env.DB;
  const notes: string[] = [];
  let signOut = false;

  if (body.role !== undefined) {
    const role = parseRole(body.role);
    if (role !== target.role) {
      if (self) throw new HttpError(400, 'You cannot change your own role');
      const res = await db.prepare(`UPDATE users SET role = ? WHERE id = ? AND ${KEEPS_AN_ADMIN}`).bind(role, id).run();
      if (!res.meta.changes) throw new HttpError(400, 'At least one admin account must remain');
      target.role = role;
      notes.push(`role -> ${role}`);
      signOut = true;
    }
  }
  if (body.password !== undefined) {
    // Own password goes through /auth/password, which asks for the current one.
    if (self) throw new HttpError(400, 'Change your own password from the Security menu');
    const password = validateNewPassword(body.password, target.username, target.role);
    await db
      .prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?')
      .bind(await hashPassword(ctx.env, password), Date.now(), id)
      .run();
    notes.push('password reset');
    signOut = true;
  }
  if (body.resetMfa === true) {
    if (self) throw new HttpError(400, 'Turn off your own two-step sign-in from the Security menu');
    await db
      .prepare('UPDATE users SET mfa_secret = NULL, mfa_pending_secret = NULL, mfa_enabled = 0, mfa_recovery = NULL WHERE id = ?')
      .bind(id)
      .run();
    notes.push('two-step sign-in reset');
    signOut = true;
  }
  if (!notes.length) throw new HttpError(400, 'Nothing to update');
  const stmts: D1PreparedStatement[] = [bumpStmt(ctx.env, 'users')];
  if (signOut) stmts.push(db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id));
  await db.batch(stmts);
  await auditCtx(ctx, 'user_updated', `${target.username}: ${notes.join(', ')}`);
  return json({ ok: true });
}

// DELETE /api/users/:id  (admin)
export async function handleDeleteUser(ctx: Ctx): Promise<Response> {
  const id = ctx.params.id;
  if (id === ctx.user!.id) throw new HttpError(400, 'You cannot delete your own account');
  const target = await ctx.env.DB.prepare('SELECT username FROM users WHERE id = ?').bind(id).first<{ username: string }>();
  if (!target) throw new HttpError(404, 'User not found');
  const res = await ctx.env.DB.prepare(`DELETE FROM users WHERE id = ? AND ${KEEPS_AN_ADMIN}`).bind(id).run();
  if (!res.meta.changes) throw new HttpError(400, 'At least one admin account must remain');
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
    ctx.env.DB.prepare('DELETE FROM machine_owners WHERE user_id = ?').bind(id),
    ctx.env.DB.prepare('DELETE FROM login_challenges WHERE user_id = ?').bind(id),
    bumpStmt(ctx.env, 'users'),
    bumpStmt(ctx.env, 'machines'),
  ]);
  await auditCtx(ctx, 'user_deleted', target.username);
  return json({ ok: true });
}
