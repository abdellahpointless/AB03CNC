import { describe, expect, it } from 'vitest';
import { camProgram } from '../src/lib/cam/program';
import { analyseProgram, DEFAULT_JAW_HEIGHT } from '../src/lib/setups';
import { parseToolpath, speedsFor } from '../src/lib/toolpath';
import { heightPart } from './heightPart';

// How CAM AI holds the part in the vise, against the engineers' programs (Phase 6: their parallels, not the tallest ones).

// A 40x30x12 plate with a 20x12 pocket 6 deep in its top.
const plate = heightPart(Array.from({ length: 30 }, (_, j) => Array.from({ length: 40 }, (_, i) => (i >= 10 && i < 30 && j >= 9 && j < 21 ? 6 : 12))));
const base = { material: 'ALU' as const, tools: [], brand: 'HAAS', noNest: true, orient: { side: 'Z+', spin: false } };

describe('the first clamping', () => {
  it.each([
    [22, 'stock enough under the part for the outside to go through'],
    [16, 'only 2 mm under the part: the jaws hold the foot of its wall, the next clamping cuts the outside left there'],
  ])('stands on 40 mm parallels, gripped 5 mm, as the shop holds it (79 of 95 first clampings): raw %i high, %s', (rawH) => {
    const r = camProgram({ ...base, tris: plate, raw: [44, 34, rawH] });
    expect(r.setups[0].cale).toBe(40);
    expect(r.setups[0].grip).toBe(5);
    expect(r.setups[0].notes).toContain('40 MM UNTERLAGE');
    expect(r.setups).toHaveLength(2);
    expect(r.setups.every((s) => s.physics.ok)).toBe(true);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
  }, 300_000);

  it('grips a thin part as little as holds, so the outside cuts of its two clampings still meet', () => {
    // A 40 x 30 x 4 plate on a 6 mm blank: 5 mm would leave the outside between the clampings' jaws uncut.
    const thin = heightPart(Array.from({ length: 30 }, () => Array.from({ length: 40 }, () => 4)));
    const r = camProgram({ ...base, tris: thin, raw: [44, 34, 6] });
    expect(r.setups[0].grip).toBe(3);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
  }, 300_000);
});

describe('a later clamping', () => {
  const jawTops = (r: ReturnType<typeof camProgram>) => analyseProgram(parseToolpath(r.code, speedsFor('HAAS')), { jawHeight: DEFAULT_JAW_HEIGHT }).setups.map((s) => s.jawTopZ!);

  it('grips as deep as its own cuts beside the held faces allow, 1 mm under them (the shop: 101 of 160 later clampings), not 3 mm', () => {
    // Raw 22: 5 mm under the part, gripped 5 mm in the first clamping, whose outside stops 0.5 mm over the part's bottom.
    const r = camProgram({ ...base, tris: plate, raw: [44, 34, 22] });
    expect(r.setups).toHaveLength(2);
    expect(r.setups[1].grip).toBeGreaterThanOrEqual(7);
    // The jaws 1 mm under the 0.5 mm of outside the first clamping left, and under the deburring graver (0.3 deep).
    expect(jawTops(r)[1]).toBeLessThanOrEqual(-1.3);
    expect(r.setups.every((s) => s.physics.ok)).toBe(true);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
  }, 300_000);

  it('stays on the faces it holds at 3 mm: a boss is gripped no deeper than the boss, its size written', () => {
    // A 30 x 30 x 6 flange with a 16 x 16 boss 10 high: turned over, the jaws hold the boss, 1 mm short of the flange.
    const flanged = heightPart(Array.from({ length: 30 }, (_, j) => Array.from({ length: 30 }, (_, i) => (i >= 7 && i < 23 && j >= 7 && j < 23 ? 16 : 6))));
    const r = camProgram({ ...base, tris: flanged, raw: [34, 34, 20] });
    const s = r.setups[1];
    expect(s.side).toBe('Z-');
    expect(s.grip).toBeGreaterThan(3);
    expect(s.grip).toBeLessThanOrEqual(9);
    expect(s.held[2] - s.held[0]).toBeCloseTo(16, 1);
    expect(s.held[3] - s.held[1]).toBeCloseTo(16, 1);
    expect(s.physics.issues.map((i) => i.key)).not.toContain('jawContact');
    expect(s.physics.issues.map((i) => i.key)).not.toContain('restContact');
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
  }, 300_000);
});
