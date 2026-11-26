import { describe, expect, it } from 'vitest';
import { camProgram, type CamInput } from '../src/lib/cam/program';
import { SIDES } from '../src/lib/cam/features';
import { apply, mul, type Mat3 } from '../src/lib/orient';
import { pocketWithHole } from './heightPart';

// You: each clamping's part turned by +90 / -90 about the machine's X or Y, the presses adding up; CAM AI plans it lying
// exactly so (any of the 24 ways), the operator's notes saying the turn from the clamping before.

const RX: Mat3 = [1, 0, 0, 0, 0, -1, 0, 1, 0];
const RY: Mat3 = [0, 0, 1, 0, 1, 0, -1, 0, 0];
const RZ: Mat3 = [0, -1, 0, 1, 0, 0, 0, 0, 1];
const pow = (m: Mat3, n: number): Mat3 => (n <= 0 ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : mul(m, pow(m, n - 1)));
/** The model side a frame puts up. */
const upSide = (R: Mat3) => SIDES.find((s) => apply(R, s.d)[2] === 1)!.name;

// 40 x 30 x 12, a pocket off the middle and a Ø4 hole through its floor: every way it lies is a different program.
const base: CamInput = { tris: pocketWithHole(40, 30, 12, [6, 6, 22, 20], 5, { c: [14, 13], d: 4 }), material: 'ALU', tools: [], brand: 'HAAS', raw: [46, 36, 46], noNest: true };
// As the page asks: each turned clamping's side the one its turn puts up (clamping 2's as `second`).
const plan = (frames: (Mat3 | null)[]) => camProgram({ ...base, orient: { side: upSide(frames[0] ?? [1, 0, 0, 0, 1, 0, 0, 0, 1]), spin: false }, ...(frames[1] ? { second: upSide(frames[1]) } : {}), frames });

describe('the part turned by hand, clamping by clamping', () => {
  it('lays clamping 1 exactly as turned: each side up, each quarter turn about Z', () => {
    const asked: Mat3[] = [pow(RZ, 1), pow(RZ, 2), mul(RX, RZ), mul(pow(RY, 3), pow(RZ, 2)), mul(RY, RX), mul(pow(RX, 2), pow(RZ, 3))];
    // Six different sides up or turns, none the planner's own way.
    expect(new Set(asked.map((R) => R.join())).size).toBe(6);
    for (const R of asked) {
      const r = plan([R]);
      expect(r.setups[0].R, R.join()).toEqual(R);
      expect(r.setups[0].side).toBe(upSide(R));
      expect(r.check.collisions, R.join()).toBe(0);
      expect(r.check.match, R.join()).toBeGreaterThanOrEqual(0.99);
    }
  }, 900_000);

  it('turns clamping 2 as asked from clamping 1, and tells the operator so', () => {
    const R0: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    // Turned over about Y (not the shop's usual X), then a quarter about X: two turns from clamping 1.
    const overY = mul(pow(RY, 2), R0);
    const r = plan([R0, overY]);
    expect(r.setups[1].R).toEqual(overY);
    expect(r.setups[1].notes.join(' ')).toMatch(/TEIL 180 GRAD UM Y DREHEN/);
    const quarterX = mul(RX, R0);
    const q = plan([R0, quarterX]);
    expect(q.setups[1].R).toEqual(quarterX);
    expect(q.setups[1].side).toBe(upSide(quarterX));
    expect(q.setups[1].notes.join(' ')).toMatch(/TEIL 90 GRAD UM X DREHEN/);
    for (const x of [r, q]) {
      expect(x.check.collisions).toBe(0);
      expect(x.check.match).toBeGreaterThanOrEqual(0.99);
    }
  }, 900_000);

  it('ignores a frame that is not a turn of the part', () => {
    const mirror: Mat3 = [-1, 0, 0, 0, 1, 0, 0, 0, 1];
    const scaled = [2, 0, 0, 0, 1, 0, 0, 0, 1] as Mat3;
    const own = camProgram({ ...base, orient: { side: 'Z+', spin: false } });
    for (const bad of [mirror, scaled]) {
      const r = camProgram({ ...base, orient: { side: 'Z+', spin: false }, frames: [bad] });
      expect(r.setups[0].R).toEqual(own.setups[0].R);
    }
  }, 900_000);
});
