import { describe, expect, it } from 'vitest';
import { alternatives, catalog, cutData, LIBRARY } from '../src/lib/cam/tools';
import { cleanDbTool, codeOf, type ToolDb } from '../src/lib/cam/toolDb';

// The shop's tool database (item 20): templates removed or given their own cutting data, tools added.
const mill = LIBRARY.ALU.find((t) => t.type === 'SF' && t.d === 8 && t.length === 40)!;
const limits = { maxRpm: 8000, maxFeed: 10000 };

describe("CAM AI's tool database as the shop changed it", () => {
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
    // What the operator types for one program wins over the database.
    const typed = catalog('ALU', [], { toolDb: { ALU: { [mill.code]: { cuts: { [kind]: { f: 9000, ap: 8, ae: 8 } } } } }, cuts: { [mill.code]: { f: 700 } } }).find((t) => t.code === mill.code)!;
    expect(cutData(typed, 'contour', 'ALU', limits)).toMatchObject({ f: 700, unsafe: false });
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

  it('ignores a stored row the planner may not take', () => {
    const db = { ALU: { [mill.code]: { removed: 'yes' }, 'SF_07.00_038_000_ALHS': { added: { type: 'KF', d: 7, length: 38 } } } } as unknown as ToolDb;
    expect(catalog('ALU', [], { toolDb: db })).toEqual(catalog('ALU', []));
  });
});
