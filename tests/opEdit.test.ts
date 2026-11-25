import { describe, expect, it } from 'vitest';
import { editOpLines, keepAbove, scaleSpeeds } from '../src/lib/cam/opEdit';

describe('no cut within 0.5 mm of the vise floor (the part on the table, you)', () => {
  it('raises only the Z words under the floor, on moves and drill cycles, never a tool change, a machine position or a comment', () => {
    const lines = ['T5 M6', '(Z-90 IN A COMMENT)', 'G0 X1. Y2. Z5.', 'G1 Z-60. F300.', 'G2 X3. Y2. Z-55. I1. J0.', 'G81 X4. Y4. Z-58. R2. F120.', 'G53 Z-70.', 'G1 Z-40.'];
    expect(keepAbove(lines, -49.5)).toEqual(['T5 M6', '(Z-90 IN A COMMENT)', 'G0 X1. Y2. Z5.', 'G1 Z-49.5 F300.', 'G2 X3. Y2. Z-49.5 I1. J0.', 'G81 X4. Y4. Z-49.5 R2. F120.', 'G53 Z-70.', 'G1 Z-40.']);
    // Nothing under it: the very same lines.
    const high = ['G1 Z-10.'];
    expect(keepAbove(high, -49.5)).toBe(high);
  });
});

describe('an operation moved or taken deeper by hand (you, Beta 2: item 10)', () => {
  const pocket = ['G00 G90 X10. Y5. S3000 M03', 'G00 Z2.', 'G01 Z-4. F300.', 'G01 X20. Y5. F600.', 'G01 Z-6. F300.', 'G01 X10. Y5.', 'G00 Z2.'];
  it('shifts every point by X, Y, Z, and nothing else (speeds, feeds, the spindle line’s S and M)', () => {
    expect(editOpLines(pocket, { dx: 1, dy: -0.5, dz: 0.2 })).toEqual(['G00 G90 X11. Y4.5 S3000 M03', 'G00 Z2.2', 'G01 Z-3.8 F300.', 'G01 X21. Y4.5 F600.', 'G01 Z-5.8 F300.', 'G01 X11. Y4.5', 'G00 Z2.2']);
  });
  it('takes only the deepest level deeper, never the clearance or an upper level', () => {
    expect(editOpLines(pocket, { deeper: 0.5 })).toEqual(['G00 G90 X10. Y5. S3000 M03', 'G00 Z2.', 'G01 Z-4. F300.', 'G01 X20. Y5. F600.', 'G01 Z-6.5 F300.', 'G01 X10. Y5.', 'G00 Z2.']);
  });
  it('moves a drilling cycle with its R plane, its depth deeper, its peck as it was', () => {
    const drill = ['G00 G90 X5. Y5. S2000 M03', 'G98 G83 X5. Y5. Z-12. R2. Q3. F100.', 'X15. Y5.', 'G80'];
    expect(editOpLines(drill, { dz: 1, deeper: 0.5 })).toEqual(['G00 G90 X5. Y5. S2000 M03', 'G98 G83 X5. Y5. Z-11.5 R3. Q3. F100.', 'X15. Y5.', 'G80']);
  });
  it('leaves the tool change, machine positions and comments alone', () => {
    const misc = ['T5 M6', 'G00 G53 Z0.', 'G43 H5 Z50.', '(FRAESEN 8MM)', 'M0 (CHECK)'];
    expect(editOpLines(misc, { dx: 3, dy: 3, dz: 3, deeper: 1 })).toEqual(misc);
  });
});

import { camProgram, editProgram } from '../src/lib/cam/program';
import { catalog } from '../src/lib/cam/tools';
import { heightPart } from './heightPart';

describe('a tool changed by hand on one operation (you, Beta 2: item 11)', () => {
  it('scales the spindle and the feeds by the same factor (constant surface speed, the same feed a turn)', () => {
    expect(scaleSpeeds(['G00 G90 X10. Y5. S3000 M03', 'G01 Z-4. F300.', 'G01 X20. F600.', 'G00 Z2.'], 0.8)).toEqual(['G00 G90 X10. Y5. S2400 M03', 'G01 Z-4. F240.', 'G01 X20. F480.', 'G00 Z2.']);
  });
});

describe('a made program edited by hand, checked again whole (you, Beta 2: items 10 and 11)', () => {
  const plate = heightPart(Array.from({ length: 30 }, (_, j) => Array.from({ length: 40 }, (_, i) => (i >= 10 && i < 30 && j >= 9 && j < 21 ? 6 : 12))));
  const input = { tris: plate, material: 'ALU' as const, tools: [], brand: 'HAAS' as const, noNest: true, orient: { side: 'Z+', spin: false }, margins: { lo: [5, 2, 5] as [number, number, number], hi: [5, 2, 2] as [number, number, number] } };
  const made = camProgram(input);
  const OUTLINE = 'Z+|FRAESEN_16MM|SFH_16.00_055_000_ALHS|0';
  const POCKET = 'Z+|FRAESEN_8MM|SF_08.00_040_000_ALHS|0';

  it('starts from a program that passes', () => {
    expect(made.check.collisions).toBe(0);
    expect(made.check.match).toBeGreaterThanOrEqual(0.99);
  });

  it('locks an outline moved 3 mm down, into the jaws (a collision)', () => {
    // Moved sideways it stays 0.5 mm over the jaw tops where it passes them (the planner keeps it there): no collision.
    const r = editProgram(input, made, { [OUTLINE]: { dz: -3 } });
    expect(r.check.collisions).toBeGreaterThan(0);
  }, 300_000);

  it('locks an outline taken 5 mm deeper, into the jaws and the parallels', () => {
    const r = editProgram(input, made, { [OUTLINE]: { deeper: 5 } });
    expect(r.check.collisions + r.check.cales).toBeGreaterThan(0);
  }, 300_000);

  it('gives a changed tool its Ø and length in the program, a code and a number no machine has, and slower speeds for a bigger one', () => {
    const r = editProgram(input, made, { [POCKET]: { tool: { d: 10, l: 40 } } });
    const op = r.setups[0].ops.find((o) => o.name === 'FRAESEN_8MM')!;
    const was = made.setups[0].ops.find((o) => o.name === 'FRAESEN_8MM')!;
    expect(op.tool.diameter).toBe(10);
    // The shop's pattern (the remapper reads the type, Ø and length from it), no inventory's ending.
    expect(op.tool.code).toBe('SF_10.00_040_000_HAND');
    expect(op.tool.inMachine).toBe(false);
    expect(r.setups.flatMap((s) => s.ops).filter((o) => o !== op).map((o) => o.tool.number)).not.toContain(op.tool.number);
    expect(r.code).toContain('(DIAMETER 10.00 MM/LENGTH 40.00 MM)');
    expect(op.cut.s).toBe(Math.round((was.cut.s * 0.8) / 50) * 50);
  }, 300_000);

  it('swaps in any tool of the shop by its code, even another kind: its own code, type and size on the same path (item 6)', () => {
    const was = made.setups[0].ops.find((o) => o.name === 'FRAESEN_8MM')!;
    const other = catalog('ALU', []).find((x) => x.type !== was.tool.type && x.diameter <= 8 && x.length >= 30)!;
    const r = editProgram(input, made, { [POCKET]: { tool: { d: other.diameter, l: other.length, code: other.code } } });
    const op = r.setups[0].ops.find((o) => o.name === 'FRAESEN_8MM')!;
    expect(op.tool.code).toBe(other.code);
    expect(op.tool.type).toBe(other.type);
    expect(op.tool.diameter).toBe(other.diameter);
    expect(op.lines.filter((l) => !/[SF]\d/.test(l))).toEqual(was.lines.filter((l) => !/[SF]\d/.test(l)));
    expect(r.setups.flatMap((s) => s.ops).filter((o) => o.tool.code !== other.code).map((o) => o.tool.number)).not.toContain(op.tool.number);
    // A tool from the database, not in the machine, never takes a number the machine has (the operator would load that).
    const machine = [99, 98, 97].map((n) => ({ id: `m${n}`, number: n, category: 'fraise' as const, description: 'SF_04.00_030_000_X', diameter: 4, length: 30 }));
    const r2 = editProgram({ ...input, tools: machine }, made, { [POCKET]: { tool: { d: other.diameter, l: other.length, code: other.code } } });
    expect([99, 98, 97]).not.toContain(r2.setups[0].ops.find((o) => o.name === 'FRAESEN_8MM')!.tool.number);
    // A code the shop has no tool for is refused, never planned.
    expect(() => editProgram(input, made, { [POCKET]: { tool: { d: 8, l: 40, code: 'NOPE_08.00_040_000_X' } } })).toThrow();
  }, 300_000);

  it('deletes an operation by hand: its lines and, with no other operation for it, its tool change; the rest as made (item 4)', () => {
    const r = editProgram(input, made, { [POCKET]: { off: true } });
    expect(r.setups[0].ops.some((o) => o.name === 'FRAESEN_8MM')).toBe(false);
    expect(r.setups[0].ops.length).toBe(made.setups[0].ops.length - 1);
    expect(r.code).not.toContain('SF_08.00_040_000_ALHS');
    // What it would have cut is left: the check says so.
    expect(r.check.match).toBeLessThan(made.check.match);
    expect(() => editProgram(input, made, { [POCKET]: { off: false as unknown as true } })).toThrow();
  }, 300_000);

  it('catches a bigger tool on a path made for a smaller one (the outline’s Ø16 swapped for a Ø20)', () => {
    const r = editProgram(input, made, { [OUTLINE]: { tool: { d: 20, l: 55 } } });
    // Its path was made for the Ø16: the Ø20 cuts 2 mm into every wall it follows, or into what holds the part.
    expect(r.check.collisions > 0 || r.check.pieces.some((p) => p.kind === 'cut')).toBe(true);
    expect(r.check.match).toBeLessThan(0.99);
  }, 300_000);

  it('locks an outline pushed sideways into the jaw below its top (3 mm toward the moving jaw, 1 mm down)', () => {
    const r = editProgram(input, made, { [OUTLINE]: { dy: -3, dz: -1 } });
    expect(r.check.collisions).toBeGreaterThan(0);
  }, 300_000);

  it('locks anything taken down to the vise floor, which the simulation does not have (a floor note)', () => {
    // The plate on 40 mm parallels: the floor 40 mm under the stock's bottom (17 mm under the top): Z-57.
    const r = editProgram(input, made, { [POCKET]: { dz: -52 } });
    expect(r.notes).toContainEqual(expect.objectContaining({ key: 'floorHit', setup: 1 }));
  }, 300_000);

  it('never runs a smaller tool faster than made, and calls a step-down deeper than its Ø unsafe', () => {
    const r = editProgram(input, made, { [OUTLINE]: { tool: { d: 3, l: 30 } } });
    const was = made.setups[0].ops.find((o) => o.name === 'FRAESEN_16MM')!;
    const op = r.setups[0].ops.find((o) => o.name === 'FRAESEN_16MM')!;
    expect(op.cut.f).toBeLessThanOrEqual(was.cut.f);
    expect(op.lines.join(' ').match(/F(\d+)/g)!.map((f) => Number(f.slice(1))).every((f) => f <= Math.max(...was.lines.join(' ').match(/F(\d+)/g)!.map((x) => Number(x.slice(1)))))).toBe(true);
    expect(op.cut.unsafe).toBe(true);
  }, 300_000);

  it('loads the vise check with the deeper last pass', () => {
    const r = editProgram(input, made, { [POCKET]: { deeper: 2 } });
    const op = r.setups[0].ops.find((o) => o.name === 'FRAESEN_8MM')!;
    const was = made.setups[0].ops.find((o) => o.name === 'FRAESEN_8MM')!;
    expect(op.cut.ap).toBeCloseTo(was.cut.ap + 2, 6);
  }, 300_000);

  it('lets a pocket go 2 mm deeper (no collision) and shows what it cuts out of the part', () => {
    // shortcut: 0.5 mm deeper on the 8 mm mill's corners is under what the check's grid sees here (< 2 mm³ a piece).
    const r = editProgram(input, made, { [POCKET]: { deeper: 2 } });
    expect(r.check.collisions).toBe(0);
    expect(r.check.misplaced).toBe(0);
    expect(r.check.pieces.some((p) => p.kind === 'cut')).toBe(true);
    expect(r.setups[0].ops.find((o) => o.name === 'FRAESEN_8MM')!.lines.join(' ')).toContain('Z-8.');
    expect(r.check.match).toBeLessThan(0.99);
    // The vise check of that clamping is done again with the edited cuts.
    expect(r.setups[0].physics).not.toBe(made.setups[0].physics);
    expect(r.setups[1].physics).toBe(made.setups[1].physics);
  }, 300_000);
});
