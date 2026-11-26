import { describe, expect, it } from 'vitest';
import { camProgram, type CamInput } from '../src/lib/cam/program';
import { analyseProgram } from '../src/lib/setups';
import { parseToolpath, speedsFor } from '../src/lib/toolpath';
import { columnPart } from './heightPart';

// You (with a picture): a part whose narrow lower step sat on the parallels when its wider, higher step should have, on
// taller parallels. The engineers write the thickness where the parallels touch the part ("35 MM UNTERLAGE IN EP 8 MM"):
// CAM AI rests it so by itself, or at the thickness typed.

/** A 40 x 30 flange 6 thick (Z 10 to 16) over a boss bw x 12 x 10 in its middle (Z 0 to 10). */
const flanged = (bw: number, bl = 12) => {
  const [x0, y0] = [(40 - bw) / 2, (30 - bl) / 2];
  const inBoss = (i: number, j: number) => i >= x0 && i < x0 + bw && j >= y0 && j < y0 + bl;
  return columnPart(
    Array.from({ length: 30 }, (_, j) => Array.from({ length: 40 }, (_, i) => (inBoss(i, j) ? 0 : 10))),
    Array.from({ length: 30 }, () => Array.from({ length: 40 }, () => 16)),
  );
};
// Clamping 1 with the boss up (its outline cut whole, the stock under it gripped), clamping 2 the flange up.
const base: CamInput = { tris: flanged(16), material: 'ALU', tools: [], brand: 'HAAS', raw: [44, 34, 22], orient: { side: 'Z-', spin: false }, noNest: true };
const restOf = (r: ReturnType<typeof camProgram>, k: number) => analyseProgram(parseToolpath(r.code, speedsFor('HAAS')), { jawHeight: 45 }).setups[k];

describe('resting on the parallels by a wider step', () => {
  it('rests the flange on the parallels, its boss hanging between them, as the engineers write it', () => {
    const r = camProgram(base);
    const s = r.setups[1];
    expect(s.side).toBe('Z+');
    // The parallels 6 mm under Z0 (the flange's underside), tall enough for the 10 mm boss and a 4 mm grip of the flange.
    expect(s.notes).toContain('41 MM UNTERLAGE IN EP 6 MM');
    expect(s.cale).toBe(41);
    expect(s.grip).toBe(4);
    // The simulation lays it the same way: on parallels 6 mm under Z0, the boss over the vise floor.
    const a = restOf(r, 1);
    expect(a.restZ).toBeCloseTo(-6, 1);
    expect(a.cales?.every((c) => Math.abs(c.top - -6) < 0.05)).toBe(true);
    expect(a.floorZ!).toBeLessThan(a.stock!.min[2] - 4.9);
    expect(r.check).toMatchObject({ collisions: 0, cales: 0, misplaced: 0 });
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
  }, 900_000);

  it('rests it at the thickness typed, and says so when the part has no step there', () => {
    const typed = camProgram({ ...base, steps: [null, 6] });
    expect(typed.setups[1].notes).toContain('41 MM UNTERLAGE IN EP 6 MM');
    const wrong = camProgram({ ...base, steps: [null, 3] });
    expect(wrong.notes).toContainEqual(expect.objectContaining({ key: 'stepRefused', setup: 2, cale: 3 }));
    expect(wrong.check.collisions).toBe(0);
  }, 900_000);

  it('turns it a quarter when the parallels only fit beside the body along the jaws', () => {
    // The boss 26 wide in Y of the flange's 30 (no room across the jaws), 16 of 40 in X: turned 90° in the vise, the
    // jaws on the flange's 40 mm faces, the parallels under its X ends.
    const r = camProgram({ ...base, tris: flanged(16, 26) });
    const s = r.setups[1];
    expect(s.notes.join(' ')).toMatch(/TEIL 90 GRAD UM Z DREHEN/);
    expect(s.notes).toContain('41 MM UNTERLAGE IN EP 6 MM');
    expect(r.check).toMatchObject({ collisions: 0, cales: 0, misplaced: 0 });
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
  }, 900_000);

  it('keeps the parallels under the body when the step is too narrow for them either way', () => {
    // The boss 36 x 26 of the flange's 40 x 30: no room for a parallel beside it under the flange.
    const r = camProgram({ ...base, tris: flanged(36, 26) });
    expect(r.setups[1].notes.join(' ')).not.toMatch(/IN EP/);
    expect(r.check.collisions).toBe(0);
  }, 900_000);
});
