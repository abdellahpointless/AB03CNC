import { describe, expect, it } from 'vitest';
import { camProgram } from '../src/lib/cam/program';
import { heightPart } from './heightPart';

// The owner: the turns between clampings shown and changeable: turned over about X or Y (the opposite side), then in
// the vise in quarter turns. The turn written in the M0 note follows the frame; the check judges it as any other.
describe('a later clamping turned as the designer asks', () => {
  const plate = heightPart(Array.from({ length: 30 }, (_, j) => Array.from({ length: 40 }, (_, i) => (i >= 10 && i < 30 && j >= 9 && j < 21 ? 6 : 12))));
  const t = Array.from(plate);
  for (let k = 0; k < t.length; k += 3) [t[k], t[k + 2]] = [t[k + 2], -t[k]];
  const input = { tris: new Float32Array(t), material: 'ALU' as const, tools: [], brand: 'HAAS' as const, noNest: true, orient: { side: 'Y+', spin: false } };
  const turnOf = (r: ReturnType<typeof camProgram>, i: number) => r.setups[i].notes[0].split('/').filter((x) => /DREHEN/.test(x)).join(' / ');
  const passes = (r: ReturnType<typeof camProgram>) => {
    expect(r.check.collisions).toBe(0);
    expect(r.check.misplaced).toBe(0);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
  };
  const made = camProgram(input);

  it('turns clamping 2 over about Y instead of X, written so, checked', () => {
    expect(turnOf(made, 1)).toMatch(/180 GRAD UM X DREHEN/);
    const r = camProgram({ ...input, turns: [null, { flip: 'Y' }] });
    expect(r.setups.map((s) => s.side)).toEqual(made.setups.map((s) => s.side));
    expect(turnOf(r, 1)).toMatch(/180 GRAD UM Y DREHEN/);
    passes(r);
  }, 900_000);

  it('turns a later clamping a half turn in the vise: its frame turned 180° about Z, checked', () => {
    const r = camProgram({ ...input, turns: [null, null, { quarter: 2 }] });
    const [a, b] = [made.setups[2].R, r.setups[2].R];
    // Machine X and Y rows reversed, Z kept.
    for (let k = 0; k < 6; k++) expect(b[k]).toBeCloseTo(-a[k], 9);
    for (let k = 6; k < 9; k++) expect(b[k]).toBeCloseTo(a[k], 9);
    // Written so: the operator turns it the other way (here "Z+ WIRD Y+" for "Z+ WIRD Y-").
    expect(r.setups[2].notes[0]).not.toBe(made.setups[2].notes[0]);
    passes(r);
  }, 900_000);

  it('a flip asked of a clamping that is not the opposite side changes nothing', () => {
    const r = camProgram({ ...input, turns: [null, null, { flip: 'Y' }] });
    expect(r.setups[2].R).toEqual(made.setups[2].R);
  }, 900_000);
});
