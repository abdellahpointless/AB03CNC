import { HttpError, json, readJson } from '../http';
import { bumpStmt, newId, type Ctx, type Role } from '../context';
import { assertNotMasterUsername, hashPassword, validateNewPassword, validateUsername } from '../auth';
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
    'SELECT id, username, role, created_at, mfa_enabled, toolpath_beta, cam_ai FROM users ORDER BY role, username COLLATE NOCASE',
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
  await assertNotMasterUsername(ctx.env, username);

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

const FLAGS = {
  toolpathBeta: { key: 'toolpathBeta', column: 'toolpath_beta', label: 'toolpath beta' },
  camAi: { key: 'camAi', column: 'cam_ai', label: 'CAM AI' },
} as const;

// PATCH /api/users/:id { password?, role?, resetMfa? } or { toolpathBeta } or { camAi }  (admin)
export async function handleUpdateUser(ctx: Ctx): Promise<Response> {
  const id = ctx.params.id;
  const body = await readJson<{ password?: unknown; role?: unknown; resetMfa?: unknown; toolpathBeta?: unknown; camAi?: unknown }>(ctx.request, 10_000);
  const target = await ctx.env.DB.prepare('SELECT id, username, role FROM users WHERE id = ?')
    .bind(id)
    .first<{ id: string; username: string; role: Role }>();
  if (!target) throw new HttpError(404, 'User not found');
  // Toolpath beta access alone: no sign-out (it takes effect when the person reloads the app).
  // Beta switches an admin sets per person (toolpath viewer, CAM AI): one at a time, on its own.
  const flag = body.toolpathBeta !== undefined ? FLAGS.toolpathBeta : body.camAi !== undefined ? FLAGS.camAi : null;
  if (flag) {
    const on = body[flag.key];
    const rest = [body.password, body.role, body.resetMfa, body[flag.key === 'toolpathBeta' ? 'camAi' : 'toolpathBeta']];
    if (typeof on !== 'boolean' || rest.some((x) => x !== undefined)) throw new HttpError(400, `${flag.key} must be true or false, on its own`);
    await ctx.env.DB.batch([ctx.env.DB.prepare(`UPDATE users SET ${flag.column} = ? WHERE id = ?`).bind(on ? 1 : 0, id), bumpStmt(ctx.env, 'users')]);
    await auditCtx(ctx, 'user_updated', `${target.username}: ${flag.label} ${on ? 'on' : 'off'}`);
    return json({ ok: true });
  }
  const self = id === ctx.user!.id;
  const db = ctx.env.DB;

  // 1. Validate every requested change first, so a bad field never leaves a half-applied update.
  let newRole: Role | null = null;
  if (body.role !== undefined) {
    const role = parseRole(body.role);
    if (role !== target.role) {
      if (self) throw new HttpError(400, 'You cannot change your own role');
      newRole = role;
    }
  }
  let newPassword: string | null = null;
  if (body.password !== undefined) {
    // Own password goes through /auth/password, which asks for the current one.
    if (self) throw new HttpError(400, 'Change your own password from the Security menu');
    newPassword = validateNewPassword(body.password, target.username, newRole ?? target.role);
  }
  const resetMfa = body.resetMfa === true;
  if (resetMfa && self) throw new HttpError(400, 'Turn off your own two-step sign-in from the Security menu');
  if (newRole === null && newPassword === null && !resetMfa) throw new HttpError(400, 'Nothing to update');

  // 2. Apply everything in one atomic batch. The role change carries the last-admin guard; if it
  //    matches nothing, the other statements are conditioned on it too.
  const stmts: D1PreparedStatement[] = [];
  const notes: string[] = [];
  if (newRole) {
    stmts.push(db.prepare(`UPDATE users SET role = ? WHERE id = ? AND ${KEEPS_AN_ADMIN}`).bind(newRole, id));
    notes.push(`role -> ${newRole}`);
  }
  const roleOk = newRole ? `AND role = '${newRole}'` : '';
  if (newPassword !== null) {
    stmts.push(
      db
        .prepare(`UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ? ${roleOk}`)
        .bind(await hashPassword(ctx.env, newPassword), Date.now(), id),
    );
    notes.push('password reset');
  }
  if (resetMfa) {
    stmts.push(
      db
        .prepare(`UPDATE users SET mfa_secret = NULL, mfa_pending_secret = NULL, mfa_enabled = 0, mfa_recovery = NULL WHERE id = ? ${roleOk}`)
        .bind(id),
    );
    notes.push('two-step sign-in reset');
  }
  stmts.push(
    db.prepare(`DELETE FROM sessions WHERE user_id = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? ${roleOk})`).bind(id, id),
    db.prepare(`DELETE FROM login_challenges WHERE user_id = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? ${roleOk})`).bind(id, id),
    bumpStmt(ctx.env, 'users'),
  );
  const results = await db.batch(stmts);
  if (newRole && !results[0].meta.changes) throw new HttpError(400, 'At least one admin account must remain');
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
