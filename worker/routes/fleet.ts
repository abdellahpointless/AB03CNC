import { HttpError, json, optNum, readJson, str } from '../http';
import { bumpStmt, newId, type Ctx, type Env } from '../context';
import { DEFAULT_CHECKS, DEFAULT_CHECKS_TR } from '../fleet';
import { MACHINE_BRANDS, MACHINE_IMAGES, type MachineBrand } from '../../src/regions';

/*
 * The machine list of one country. Every country (database) has its own machines; admins add,
 * edit and remove them. Tools, checklists and history refer to machines by id.
 */

export interface MachineRow {
  id: string;
  name: string;
  brand: MachineBrand;
  model: string;
  image: string | null;
  pockets: number | null;
  has_tools: number;
  active: number;
  sort: number;
  created_at: number;
}

export function rowToMachine(r: MachineRow) {
  return { id: r.id, name: r.name, brand: r.brand, model: r.model, image: r.image, pockets: r.pockets, hasTools: !!r.has_tools, sort: r.sort };
}

/** Looks up an active machine of this country. `forTools` also requires a tool inventory. */
export async function requireMachine(env: Env, raw: string, opts: { forTools?: boolean } = {}): Promise<MachineRow> {
  const id = typeof raw === 'string' ? raw.toUpperCase() : '';
  if (!/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(id)) throw new HttpError(400, 'Unknown machine');
  const row = await env.DB.prepare('SELECT * FROM machines WHERE id = ? AND active = 1').bind(id).first<MachineRow>();
  if (!row || (opts.forTools && !row.has_tools)) throw new HttpError(400, 'Unknown machine');
  return row;
}

// GET /api/fleet -> this country's machines
export async function handleListFleet(ctx: Ctx): Promise<Response> {
  const { results } = await ctx.env.DB.prepare('SELECT * FROM machines WHERE active = 1 ORDER BY sort, name').all<MachineRow>();
  return json({ machines: results.map(rowToMachine) });
}

/** "Robodrill Ş-3" -> "ROBODRILL-S-3" (Turkish letters transliterated, safe for URLs). */
export function machineIdFromName(name: string): string {
  const map: Record<string, string> = { ç: 'c', ğ: 'g', ı: 'i', İ: 'i', ö: 'o', ş: 's', ü: 'u', Ç: 'c', Ğ: 'g', Ö: 'o', Ş: 's', Ü: 'u' };
  const ascii = name
    .replace(/[çğıİöşüÇĞÖŞÜ]/g, (c) => map[c] ?? c)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
  return ascii
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

interface MachineInput {
  name: string;
  brand: MachineBrand;
  model: string;
  image: string | null;
  pockets: number | null;
  hasTools: boolean;
}

function parseMachineInput(body: Record<string, unknown>, partial: boolean, current?: MachineRow): MachineInput {
  const pick = <T>(key: string, parse: (v: unknown) => T, fallback: T): T => (body[key] === undefined && partial ? fallback : parse(body[key]));
  const name = pick('name', (v) => str(v, 'Machine name', { min: 1, max: 40 }), current?.name ?? '');
  const brand = pick(
    'brand',
    (v) => {
      if (typeof v === 'string' && (MACHINE_BRANDS as string[]).includes(v)) return v as MachineBrand;
      throw new HttpError(400, `Brand must be one of: ${MACHINE_BRANDS.join(', ')}`);
    },
    current?.brand ?? 'OTHER',
  );
  const model = pick('model', (v) => (v === undefined || v === null ? '' : str(v, 'Model', { max: 40 })), current?.model ?? '');
  const image = pick(
    'image',
    (v) => {
      if (v === undefined || v === null || v === '') return null;
      if (typeof v === 'string' && MACHINE_IMAGES.some((i) => i.file === v)) return v;
      throw new HttpError(400, 'Unknown machine photo');
    },
    current?.image ?? null,
  );
  const pockets = pick('pockets', (v) => optNum(v, 'Pockets', { min: 1, max: 999, integer: true }), current?.pockets ?? null);
  const hasTools = pick('hasTools', (v) => v === undefined || v === null ? true : v === true, current ? !!current.has_tools : true);
  return { name, brand, model, image, pockets, hasTools };
}

// Admin: POST /api/fleet { name, brand, model?, image?, pockets?, hasTools? }
export async function handleCreateMachine(ctx: Ctx): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(ctx.request, 5_000);
  const m = parseMachineInput(body, false);
  const base = machineIdFromName(m.name);
  if (!base) throw new HttpError(400, 'The machine name needs at least one letter or digit');

  const { results } = await ctx.env.DB.prepare('SELECT id, name, active FROM machines').all<{ id: string; name: string; active: number }>();
  if (results.some((r) => r.active && r.name.toLowerCase() === m.name.toLowerCase())) {
    throw new HttpError(409, `A machine called "${m.name}" already exists`);
  }
  const taken = new Set(results.map((r) => r.id));
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base.slice(0, 20)}-${i}`;
  const sort = results.length ? (await ctx.env.DB.prepare('SELECT COALESCE(MAX(sort), 0) AS s FROM machines').first<{ s: number }>())!.s + 10 : 10;
  const now = Date.now();
  const checks = ctx.env.REGION === 'tr' ? DEFAULT_CHECKS_TR : DEFAULT_CHECKS;

  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `INSERT INTO machines (id, name, brand, model, image, pockets, has_tools, active, sort, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).bind(id, m.name, m.brand, m.model, m.image, m.pockets, m.hasTools ? 1 : 0, sort, now),
    ...checks.map((c, i) =>
      ctx.env.DB.prepare(
        `INSERT INTO machine_checks (id, machine_id, kind, title, frequency, sort, created_at) VALUES (?, ?, 'CHECK', ?, ?, ?, ?)`,
      ).bind(newId(), id, c.title, c.frequency, (i + 1) * 10, now),
    ),
    ctx.env.DB.prepare(
      'INSERT INTO machine_events (machine_id, check_id, check_title, action, note, username, at) VALUES (?, NULL, NULL, ?, ?, ?, ?)',
    ).bind(id, 'MACHINE_ADDED', m.name, ctx.user!.username, now),
    bumpStmt(ctx.env, 'machines'),
    bumpStmt(ctx.env, 'tools'),
  ]);
  return json({ ok: true, id });
}

// Admin: PATCH /api/fleet/:machine { name?, brand?, model?, image?, pockets?, hasTools?, sort? }
export async function handleUpdateMachine(ctx: Ctx): Promise<Response> {
  const current = await requireMachine(ctx.env, ctx.params.machine);
  const body = await readJson<Record<string, unknown>>(ctx.request, 5_000);
  const m = parseMachineInput(body, true, current);
  if (m.name.toLowerCase() !== current.name.toLowerCase()) {
    const clash = await ctx.env.DB.prepare('SELECT 1 AS x FROM machines WHERE active = 1 AND id != ? AND name = ? COLLATE NOCASE')
      .bind(current.id, m.name)
      .first();
    if (clash) throw new HttpError(409, `A machine called "${m.name}" already exists`);
  }
  const sort = body.sort === undefined ? current.sort : optNum(body.sort, 'Sort', { min: 0, max: 100_000, integer: true }) ?? current.sort;
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('UPDATE machines SET name = ?, brand = ?, model = ?, image = ?, pockets = ?, has_tools = ?, sort = ? WHERE id = ?').bind(
      m.name,
      m.brand,
      m.model,
      m.image,
      m.pockets,
      m.hasTools ? 1 : 0,
      sort,
      current.id,
    ),
    bumpStmt(ctx.env, 'machines'),
    bumpStmt(ctx.env, 'tools'),
  ]);
  return json({ ok: true });
}

// Admin: DELETE /api/fleet/:machine -> hidden everywhere; its history stays.
export async function handleRemoveMachine(ctx: Ctx): Promise<Response> {
  const current = await requireMachine(ctx.env, ctx.params.machine);
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('UPDATE machines SET active = 0 WHERE id = ?').bind(current.id),
    ctx.env.DB.prepare('DELETE FROM machine_owners WHERE machine_id = ?').bind(current.id),
    ctx.env.DB.prepare(
      'INSERT INTO machine_events (machine_id, check_id, check_title, action, note, username, at) VALUES (?, NULL, NULL, ?, ?, ?, ?)',
    ).bind(current.id, 'MACHINE_REMOVED', current.name, ctx.user!.username, Date.now()),
    bumpStmt(ctx.env, 'machines'),
    bumpStmt(ctx.env, 'tools'),
  ]);
  return json({ ok: true });
}
