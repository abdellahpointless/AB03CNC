import { describe, expect, it } from 'vitest';
import { alternatives, catalog, cutData, LIBRARY } from '../src/lib/cam/tools';
import { camProgram } from '../src/lib/cam/program';
import { heightPart } from './heightPart';
import { cleanDbTool, codeOf, searchNeedle, type ToolDb } from '../src/lib/cam/toolDb';

// The shop's tool database (item 20): templates removed or given their own cutting data, tools added.
const mill = LIBRARY.ALU.find((t) => t.type === 'SF' && t.d === 8 && t.length === 40)!;
const limits = { maxRpm: 8000, maxFeed: 10000 };

describe("CAM AI's tool database as the shop changed it", () => {
  it('searches a Ø as the list writes it, and codes as typed (finding H1-30)', () => {
    for (const q of ['8', 'Ø8', 'ø8', 'D8', ' Ø 8 ', 'd8']) expect(searchNeedle(q)).toBe('8');
    expect(searchNeedle('ø2,5')).toBe('2.5');
    expect(searchNeedle('sf_08')).toBe('SF_08');
  });
  it('changes nothing while empty', () => {
    expect(catalog('ALU', [], { toolDb: {} })).toEqual(catalog('ALU', []));
    expect(catalog('POM', [], { toolDb: { ALU: {} } })).toEqual(catalog('POM', []));
  });

  it('leaves a removed tool out of the plan and out of what can stand in for a tool', () => {
    const db: ToolDb = { ALU: { [mill.code]: { removed: true } } };
    expect(catalog('ALU', [], { toolDb: db }).some((t) => t.code === mill.code)).toBe(false);
    const other = LIBRARY.ALU.find((t) => t.type === 'SF' && t.code !== mill.code)!;
    expect(alternatives('ALU', [], other.code, [], db).some((t) => t.code === mill.code)).toBe(false);
    // Another material's family keeps it.
    expect(catalog('PCGF', [], { toolDb: { POM: { [mill.code]: { removed: true } } } }).some((t) => t.code === mill.code)).toBe(true);
  });

  it('checks saved cutting data as typed values, never as the template: too much is unsafe, the machine top still holds', () => {
    const cut = (db: ToolDb) => cutData(catalog('ALU', [], { toolDb: db }).find((t) => t.code === mill.code)!, 'contour', 'ALU', limits);
    const kind = mill.ops.find((o) => o.kind === 'contour' || o.kind === 'pocket' || o.kind === 'finish')!.kind;
    expect(cut({ ALU: { [mill.code]: { cuts: { [kind]: { s: 20000, f: 900, ae: 2, ap: 1 } } } } })).toMatchObject({ s: 8000, f: 900, ae: 2, ap: 1, unsafe: false });
    expect(cut({ ALU: { [mill.code]: { cuts: { [kind]: { ap: 8, ae: 8, f: 9000 } } } } }).unsafe).toBe(true);
    // What the operator types for one program wins over the database, field by field (a coolant alone keeps the shop's values).
    const typed = catalog('ALU', [], { toolDb: { ALU: { [mill.code]: { cuts: { [kind]: { s: 6000, f: 900 } } } } }, cuts: { [mill.code]: { f: 700 } } }).find((t) => t.code === mill.code)!;
    expect(cutData(typed, 'contour', 'ALU', limits)).toMatchObject({ s: 6000, f: 700, unsafe: false });
    const air = catalog('ALU', [], { toolDb: { ALU: { [mill.code]: { cuts: { [kind]: { s: 6000, f: 900 } } } } }, cuts: { [mill.code]: { coolant: 'air', f: undefined } } }).find((t) => t.code === mill.code)!;
    expect(cutData(air, 'contour', 'ALU', limits)).toMatchObject({ s: 6000, f: 900 });
  });

  it('adds a tool to be loaded (never taken as in the machine), its data the shop programs’ and checked', () => {
    const code = codeOf('SF', 7, 38, 'ALU');
    const db: ToolDb = { ALU: { [code]: { added: { type: 'SF', d: 7, length: 38 } } } };
    const t = catalog('ALU', [], { toolDb: db }).find((x) => x.code === code)!;
    expect(t).toMatchObject({ code: 'SF_07.00_038_000_ALHS', type: 'SF', diameter: 7, length: 38, template: null, inMachine: false, category: 'fraise' });
    expect(catalog('ALU', [], { toolDb: db }).filter((x) => x.number === t.number)).toHaveLength(1);
    expect(cutData(t, 'contour', 'ALU', limits).from).not.toBe('template');
    const bold = catalog('ALU', [], { toolDb: { ALU: { [code]: { added: { type: 'SF', d: 7, length: 38 }, cuts: { contour: { ap: 30, ae: 7, f: 9000 } } } } } }).find((x) => x.code === code)!;
    expect(cutData(bold, 'contour', 'ALU', limits).unsafe).toBe(true);
    // A machine that has it: its own number, in the machine.
    const machine = [{ id: 'm7', number: 31, category: 'fraise' as const, description: 'FRAISE 7', diameter: 7, length: 38 }];
    expect(catalog('ALU', machine, { toolDb: db }).find((x) => x.code === code)).toMatchObject({ number: 31, inMachine: true });
  });

  it('takes only what the planner plans with, and nothing that could break a G-code comment', () => {
    expect(cleanDbTool('ALU', 'SF_07.00_038_000_ALHS', { added: { type: 'SF', d: 7, length: 38 } })).toEqual({ added: { type: 'SF', d: 7, length: 38 } });
    expect(cleanDbTool('ALU', 'ST_10.00_050_G45_ALHS', { added: { type: 'ST', d: 10, length: 50 } })).not.toBeNull();
    // The code must be the tool's own; a ball mill or a reamer is not planned with; Ø and length in range.
    expect(cleanDbTool('ALU', 'SF_07.00_040_000_ALHS', { added: { type: 'SF', d: 7, length: 38 } })).toBeNull();
    expect(cleanDbTool('ALU', 'KF_06.00_040_R03_ALHS', { added: { type: 'KF', d: 6, length: 40 } })).toBeNull();
    expect(cleanDbTool('ALU', 'SF_00.00_038_000_ALHS', { added: { type: 'SF', d: 0, length: 38 } })).toBeNull();
    expect(cleanDbTool('POM', 'SF_07.00_038_000_ALHS', { added: { type: 'SF', d: 7, length: 38 } })).toBeNull();
    expect(cleanDbTool('ALU', 'SF_08.00_040_000_ALHS) M30 (', { removed: true })).toBeNull();
    expect(cleanDbTool('XX', mill.code, { removed: true })).toBeNull();
    expect(cleanDbTool('ALU', mill.code, { cuts: { contour: { f: 0 } } })).toBeNull();
    expect(cleanDbTool('ALU', mill.code, { cuts: { contour: { s: 90000 } } })).toBeNull();
    expect(cleanDbTool('ALU', mill.code, { cuts: { warp: { f: 100 } } })).toBeNull();
    expect(cleanDbTool('ALU', mill.code, { removed: true, cuts: { contour: { f: 500 } } })).toBeNull();
    expect(cleanDbTool('ALU', mill.code, {})).toBeNull();
    // Unknown fields dropped.
    expect(cleanDbTool('ALU', mill.code, { cuts: { contour: { f: 500, x: 1 } }, note: 'x' })).toEqual({ cuts: { contour: { f: 500 } } });
  });

  it('lets every tool of the templates be changed or removed', () => {
    for (const fam of ['ALU', 'POM', 'FH'] as const) for (const t of LIBRARY[fam]) expect(cleanDbTool(fam, t.code, { removed: true }), t.code).not.toBeNull();
  });

  it('keeps a tool switched off out of the plan, and gives a role (roughing or finishing) to the tools it plans with (item 14)', () => {
    const off: ToolDb = { ALU: { [mill.code]: { off: true } } };
    expect(catalog('ALU', [], { toolDb: off }).some((t) => t.code === mill.code)).toBe(false);
    expect(catalog('ALU', [], { toolDb: { ALU: { [mill.code]: { role: 'rough' } } } }).find((t) => t.code === mill.code)!.role).toBe('rough');
    expect(cleanDbTool('ALU', mill.code, { role: 'finish', off: true })).toEqual({ role: 'finish', off: true });
    // Only the two roles, only a plain true; never with a removed row.
    expect(cleanDbTool('ALU', mill.code, { role: 'both' })).toBeNull();
    expect(cleanDbTool('ALU', mill.code, { off: false })).toBeNull();
    expect(cleanDbTool('ALU', mill.code, { removed: true, off: true })).toBeNull();
  });

  it('ignores a stored row the planner may not take', () => {
    const db = { ALU: { [mill.code]: { removed: 'yes' }, 'SF_07.00_038_000_ALHS': { added: { type: 'KF', d: 7, length: 38 } } } } as unknown as ToolDb;
    expect(catalog('ALU', [], { toolDb: db })).toEqual(catalog('ALU', []));
  });
});

// A program made with the database, simulated and checked as every program is (machine safety).
describe('a program made with the shop’s tool database', () => {
  // A 40x30x12 plate with a 20x12 pocket 6 deep in its top.
  const plate = heightPart(Array.from({ length: 30 }, (_, j) => Array.from({ length: 40 }, (_, i) => (i >= 10 && i < 30 && j >= 9 && j < 21 ? 6 : 12))));
  const input = { tris: plate, material: 'ALU', tools: [], brand: 'HAAS', raw: [44, 34, 19] as [number, number, number], orient: { side: 'Z+', spin: false }, noNest: true };
  const passes = (r: ReturnType<typeof camProgram>) => r.check.match >= 0.99 && r.check.collisions === 0 && r.check.misplaced === 0 && r.setups.every((s) => !s.ops.some((o) => o.cut.unsafe));
  const millsIn = (r: ReturnType<typeof camProgram>) => [...new Set(r.setups.flatMap((s) => s.ops.map((o) => o.tool)).filter((t) => t.type === 'SF' || t.type === 'SFH').map((t) => t.code))];
  /** Each tool change's T number with the code in the comment on the line after it. */
  const changes = (code: string) => [...code.matchAll(/T(\d+) M6\nN\d+ \([^)\n]*?([A-Z]{2,3}_[\d.]+_\d{3}_[A-Z0-9.]+_[A-Z]+)\)/g)].map((m) => [Number(m[1]), m[2]] as const);
  let base: ReturnType<typeof camProgram>;

  it('removes a tool from the program, which still passes every check', () => {
    base = camProgram(input);
    expect(passes(base)).toBe(true);
    const gone = millsIn(base)[0];
    const r = camProgram({ ...input, toolDb: { ALU: { [gone]: { removed: true } } } });
    expect(r.code).not.toContain(gone);
    expect(passes(r)).toBe(true);
  }, 900_000);

  it('never roughs with a tool the database keeps for finishing (item 14); the program still passes', () => {
    const roughs = (r: ReturnType<typeof camProgram>) => r.setups.flatMap((s) => s.ops).filter((o) => o.kind === 'pocket').map((o) => o.tool.code);
    const first = roughs(base)[0];
    const r = camProgram({ ...input, toolDb: { ALU: { [first]: { role: 'finish' } } } });
    expect(roughs(r)).not.toContain(first);
    expect(passes(r)).toBe(true);
  }, 900_000);

  it('writes the shop’s feed, and an absurd one leaves the program locked', () => {
    const tool = base.setups.flatMap((s) => s.ops).find((o) => o.tool.type === 'SF' && o.tool.template)!.tool;
    const kinds = [...new Set(tool.template!.ops.map((o) => o.kind))];
    const r = camProgram({ ...input, toolDb: { ALU: { [tool.code]: { cuts: Object.fromEntries(kinds.map((k) => [k, { f: 777 }])) } } } });
    expect(r.code).toMatch(/F777\./);
    expect(passes(r)).toBe(true);
    const bold = camProgram({ ...input, toolDb: { ALU: { [tool.code]: { cuts: Object.fromEntries(kinds.map((k) => [k, { f: 9000, ap: 30, ae: tool.diameter }])) } } } });
    expect(bold.setups.some((s) => s.ops.some((o) => o.tool.code === tool.code && o.cut.unsafe))).toBe(true);
  }, 900_000);

  it('plans with an added tool, to be loaded, its T number its own, every check passed', () => {
    // Every end mill of Ø6 and more removed: the added Ø7 is the biggest there is.
    const big = LIBRARY.ALU.filter((t) => (t.type === 'SF' || t.type === 'SFH') && t.d >= 6).map((t) => t.code);
    const code = codeOf('SF', 7, 38, 'ALU');
    const db: ToolDb = { ALU: { ...Object.fromEntries(big.map((c) => [c, { removed: true }])), [code]: { added: { type: 'SF', d: 7, length: 38 } } } };
    const r = camProgram({ ...input, toolDb: db });
    const used = r.setups.flatMap((s) => s.ops).filter((o) => o.tool.code === code);
    expect(used.length).toBeGreaterThan(0);
    expect(used.every((o) => !o.tool.inMachine && o.tool.length === 38)).toBe(true);
    expect(passes(r)).toBe(true);
    const tc = changes(r.code);
    const mine = tc.filter(([, c]) => c === code).map(([n]) => n);
    expect(mine.length).toBeGreaterThan(0);
    expect(tc.filter(([n, c]) => mine.includes(n) && c !== code)).toEqual([]);
  }, 900_000);
});
