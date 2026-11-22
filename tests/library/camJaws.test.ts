/**
 * CAM AI on reference programs whose later clamping holds the part by a band narrower than what stands
 * above it: the final validation of Phase 5 found end mills going into the jaws in two (270 and 135 hits),
 * the Phase 6 validation a graver into a jaw in one of them and a part it could not hold in another. Each
 * is planned as tools/camLibrary.ts plans it (the engineers' blank, the part's family from the header).
 * Programs by id (P and the first 8 hex digits of the file's SHA-1). Skipped without CNC_LIBRARY=<folder>.
 */
import { describe, expect, it } from 'vitest';
import { LIB, plan } from './plan';

describe.skipIf(!LIB)('reference library: CAM AI keeps off the jaws', () => {
  for (const id of ['P6b923b7f', 'Pf2990f37'])
    it(`${id}: no tool into the jaws, held by a narrow band`, { timeout: 30 * 60_000 }, async () => {
      expect((await plan(id, 'ALU')).check.collisions).toBe(0);
    });
});

describe.skipIf(!LIB)('reference library: CAM AI holds a part whose later clamping has only a narrow face', () => {
  // Pfae5765f (brass): with the blank 2 mm over the part the outside goes through first, and the turned part
  // stands on a 3.8 mm face it cannot rest on (the shop rests it on a ledge). Planned again with the blank centred.
  it('Pfae5765f: a program that passes every check', { timeout: 30 * 60_000 }, async () => {
    const r = await plan('Pfae5765f', 'MS');
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
    expect(r.check.misplaced).toBe(0);
    expect(r.setups.every((x) => x.physics.ok)).toBe(true);
  });
});
