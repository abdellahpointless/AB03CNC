import { describe, expect, it } from 'vitest';
import { editOpLines } from '../src/lib/cam/opEdit';

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
import { heightPart } from './heightPart';

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
