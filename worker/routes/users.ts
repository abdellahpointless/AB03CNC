import { HttpError, json, readJson } from '../http';
import { bumpStmt, newId, type Ctx } from '../context';
import { hashPassword, validateNewPassword, validateUsername } from '../auth';

function parseRole(v: unknown): 'ADMIN' | 'MACHINIST' {
  if (v === 'ADMIN' || v === 'MACHINIST') return v;
  throw new HttpError(400, 'Role must be ADMIN or MACHINIST');
}

// GET /api/users  (admin)
export async function handleListUsers(ctx: Ctx): Promise<Response> {
  const { results } = await ctx.env.DB.prepare(
    'SELECT id, username, role, created_at FROM users ORDER BY role, username COLLATE NOCASE',
  ).all();
  return json({ users: results });
}

// POST /api/users { username, password, role }  (admin)
export async function handleCreateUser(ctx: Ctx): Promise<Response> {
  const body = await readJson<{ username?: unknown; password?: unknown; role?: unknown }>(ctx.request, 10_000);
  const username = validateUsername(body.username);
  const password = validateNewPassword(body.password);
  const role = parseRole(body.role ?? 'MACHINIST');

  const exists = await ctx.env.DB.prepare('SELECT 1 AS x FROM users WHERE username = ?').bind(username).first();
  if (exists) throw new HttpError(409, 'User already exists');

  const id = newId();
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)').bind(
      id,
      username,
      await hashPassword(password),
      role,
      Date.now(),
    ),
    bumpStmt(ctx.env, 'users'),
  ]);
  return json({ user: { id, username, role } });
}

async function adminCount(ctx: Ctx): Promise<number> {
  return (await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'ADMIN'").first<{ n: number }>())?.n ?? 0;
}

// PATCH /api/users/:id { password?, role? }  (admin)
export async function handleUpdateUser(ctx: Ctx): Promise<Response> {
  const id = ctx.params.id;
  const body = await readJson<{ password?: unknown; role?: unknown }>(ctx.request, 10_000);
  const target = await ctx.env.DB.prepare('SELECT id, role FROM users WHERE id = ?').bind(id).first<{ id: string; role: string }>();
  if (!target) throw new HttpError(404, 'User not found');

  const stmts: D1PreparedStatement[] = [];
  if (body.role !== undefined) {
    const role = parseRole(body.role);
    if (target.role === 'ADMIN' && role !== 'ADMIN' && (await adminCount(ctx)) <= 1) {
      throw new HttpError(400, 'At least one admin account must remain');
    }
    stmts.push(ctx.env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, id));
  }
  if (body.password !== undefined) {
    const password = validateNewPassword(body.password);
    stmts.push(ctx.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(password), id));
    // A reset password signs that user out everywhere (except the admin's own session when resetting themselves).
    if (id !== ctx.user!.id) stmts.push(ctx.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id));
  }
  if (!stmts.length) throw new HttpError(400, 'Nothing to update');
  stmts.push(bumpStmt(ctx.env, 'users'));
  await ctx.env.DB.batch(stmts);
  return json({ ok: true });
}

// DELETE /api/users/:id  (admin)
export async function handleDeleteUser(ctx: Ctx): Promise<Response> {
  const id = ctx.params.id;
  if (id === ctx.user!.id) throw new HttpError(400, 'You cannot delete your own account');
  const target = await ctx.env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(id).first<{ role: string }>();
  if (!target) throw new HttpError(404, 'User not found');
  if (target.role === 'ADMIN' && (await adminCount(ctx)) <= 1) throw new HttpError(400, 'At least one admin account must remain');
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
    ctx.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
    ctx.env.DB.prepare('DELETE FROM machine_owners WHERE user_id = ?').bind(id),
    bumpStmt(ctx.env, 'users'),
    bumpStmt(ctx.env, 'machines'),
  ]);
  return json({ ok: true });
}
