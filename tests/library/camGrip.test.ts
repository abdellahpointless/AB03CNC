/**
 * How deep CAM AI's later clampings grip a reference part: as deep as this clamping's own cuts beside the held
 * faces allow, the stock it cannot reach (under the part, seen from its top) not counted (the shop holds the part
 * by as much of it as it can). Planned as tools/camLibrary.ts plans it. Programs by id (P and the first 8 hex
 * digits of the file's SHA-1). Skipped without CNC_LIBRARY=<folder>.
 */
import { describe, expect, it } from 'vitest';
import { LIB, plan } from './plan';

describe.skipIf(!LIB)('reference library: a later clamping grips by more than the last 3 mm', () => {
  // P8db5660f (FH plate, 78 x 48 x 8): the on-edge clamping for the side holes gripped 3 mm on 42 mm parallels,
  // held back by stock beside the part that lies under it seen from the top (the engineers: 25 mm).
  it('P8db5660f: its on-edge clamping grips 10 mm or more', { timeout: 30 * 60_000 }, async () => {
    const r = await plan('P8db5660f', 'FH');
    expect(Math.max(...r.setups.slice(1).map((s) => s.grip))).toBeGreaterThanOrEqual(10);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
    expect(r.setups.every((s) => s.physics.ok)).toBe(true);
  });
});

describe.skipIf(!LIB)('reference library: every clamping held (the vise check), after the Phase 7b rules', () => {
  // Passed in Phase 6; the long faces turned a side clamping so its 3 mm grip could not hold the part, and no other
  // grip could. Turned the other way round it holds. (P5ea575e1 passed in Phase 6 only on a blank turned the wrong
  // way by the harness; on its own blank no way of holding passes: an open question, not tested here.)
  it.each([['Pf2990f37', 'ALU']] as const)('%s: every clamping holds', { timeout: 60 * 60_000 }, async (id, material) => {
    const r = await plan(id, material);
    expect(r.setups.filter((s) => !s.physics.ok).map((s) => `${s.side} ${s.physics.issues.map((i) => i.key).join(',')}`)).toEqual([]);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
  });
});
