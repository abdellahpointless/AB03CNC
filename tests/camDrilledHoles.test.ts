import { describe, expect, it } from 'vitest';
import { camProgram } from '../src/lib/cam/program';
import type { CamSetup } from '../src/lib/cam/program';
import { plateWithBlindHole, plateWithCounterbore, plateWithHoles } from './heightPart';
import { haasTools } from '../src/lib/defaultTools';

// You: no end mill in a hole a drill already made (drilled at its own Ø): not to mill it again, not to make its
// bottom flush. A counterbore is made by an end mill, no drill of its Ø, after its smaller hole is drilled.

/** The mills' feed points inside a hole (the mill wholly in it), per hole, in clamping `i`. */
function millsIn(s: CamSetup, holes: { c: [number, number]; d: number }[]) {
  // The plate's middle is X0 Y0 in clamping 1 (held as it is, centred), as in the tolerance tests.
  return holes.map((h) =>
    s.ops
      .filter((o) => o.kind !== 'drill' && o.kind !== 'face')
      .flatMap((o) =>
        o.lines.flatMap((l) => {
          const x = l.match(/X(-?[\d.]+)/);
          const y = l.match(/Y(-?[\d.]+)/);
          const z = l.match(/Z(-?[\d.]+)/);
          if (!/^G0?1/.test(l) || !x || !y || !z || Number(z[1]) > -0.1) return [];
          return Math.hypot(Number(x[1]) - h.c[0], Number(y[1]) - h.c[1]) < h.d / 2 - o.tool.diameter / 2 + 0.05 && o.tool.diameter < h.d ? [`${o.name} ${l}`] : [];
        }),
      ),
  );
}

describe('a hole a drill made', () => {
  it('is never milled again (small through holes drilled at their own Ø)', () => {
    // 40 x 30 x 8, a Ø1.6 and a Ø3.2 through (the shop has both drills), 5 mm under it to grip.
    const holes = [{ c: [10, 15] as [number, number], d: 1.6 }, { c: [30, 15] as [number, number], d: 3.2 }];
    const r = camProgram({ tris: plateWithHoles(40, 30, 8, holes), material: 'ALU', tools: [], brand: 'HAAS', raw: [40, 30, 13.5], orient: { side: 'Z+', spin: false }, noNest: true });
    // Each drilled with a drill of its Ø (the shop's within 0.12 mm: the Ø3.2 with the Ø3.3).
    const drilled = r.setups[0].ops.filter((o) => o.kind === 'drill' && o.purpose === 'drill').map((o) => o.tool.diameter);
    for (const h of holes) expect(drilled.some((d) => Math.abs(d - h.d) <= 0.12), `Ø${h.d}`).toBe(true);
    // In clamping 1's frame the plate's middle is X0 Y0.
    const centred = holes.map((h) => ({ c: [h.c[0] - 20, h.c[1] - 15] as [number, number], d: h.d }));
    expect(millsIn(r.setups[0], centred)).toEqual([[], []]);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
  }, 600_000);

  it('leaves the drill\'s point at a flat-bottomed blind hole: no end mill makes its bottom flush', () => {
    // A Ø1.5 hole 6 deep, drawn flat: the Ø1.5 drill's tip at its bottom, the point left (the engineers' way).
    const tris = plateWithBlindHole(40, 30, 12, { c: [20, 15], d: 1.5, depth: 6, point: false });
    const r = camProgram({ tris, material: 'ALU', tools: [], brand: 'HAAS', raw: [40, 30, 17.5], orient: { side: 'Z+', spin: false }, noNest: true });
    expect(r.setups[0].ops.some((o) => o.kind === 'drill' && o.purpose === 'drill' && o.tool.diameter === 1.5)).toBe(true);
    expect(millsIn(r.setups[0], [{ c: [0, 0], d: 1.5 }])).toEqual([[]]);
  }, 600_000);

  it('makes a counterbore with an end mill after its hole is drilled, never with a drill of its Ø', () => {
    // 40 x 30 x 12: a Ø5.5 hole through, a Ø10 counterbore 5.5 deep from the bottom face: both from there.
    const tris = plateWithCounterbore(40, 30, 12, { c: [20, 15], d: 5.5, D: 10, depth: 5.5 });
    const r = camProgram({ tris, material: 'ALU', tools: [], brand: 'HAAS', raw: [40, 30, 17.5], orient: { side: 'Z-', spin: false }, noNest: true });
    const s = r.setups[0];
    const drills = s.ops.filter((o) => o.kind === 'drill' && o.purpose === 'drill').map((o) => o.tool.diameter);
    expect(drills).toEqual([5.5]);
    // Then an end mill cuts the Ø10 down to its floor (Z-5.5), after the drill.
    const firstDrill = s.ops.findIndex((o) => o.kind === 'drill' && o.purpose === 'drill');
    const seat = s.ops
      .map((o, i) => ({ o, i }))
      .filter(({ o }) => o.kind === 'pocket' && o.tool.diameter < 10)
      .filter(({ o }) => o.lines.some((l) => /^G0?1/.test(l) && Number(l.match(/Z(-?[\d.]+)/)?.[1] ?? 0) <= -5.4 && Math.hypot(Number(l.match(/X(-?[\d.]+)/)?.[1] ?? 99), Number(l.match(/Y(-?[\d.]+)/)?.[1] ?? 99)) < 5));
    expect(seat.length).toBeGreaterThan(0);
    expect(seat.every(({ i }) => i > firstDrill)).toBe(true);
    // No mill in the Ø5.5 hole under the counterbore's floor.
    expect(millsIn(s, [{ c: [0, 0], d: 5.5 }]).flat().filter((l) => Number(l.match(/Z(-?[\d.]+)/)![1]) < -5.6)).toEqual([]);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
  }, 600_000);

  it('never cleans a drill\'s point under the part (a through hole drilled over a parallel after the turn)', () => {
    // 60 x 40 x 12, a Ø3.3 hole 4 mm from its edge with a Ø6 counterbore 4 deep from its bottom face: drilled from there
    // after the turn, over the parallel under that edge, its point 0.95 into it (camSafety). Its narrow end lies under
    // the part's bottom (Z-12): nothing of the part, so no mill goes in after the drill.
    const tris = plateWithCounterbore(60, 40, 12, { c: [30, 4], d: 3.3, D: 6, depth: 4 });
    const r = camProgram({ tris, material: 'ALU', tools: [], brand: 'HAAS', raw: [64, 44, 19], orient: { side: 'Z+', spin: false } });
    const s = r.setups.find((x) => x.side === 'Z-')!;
    expect(s.ops.some((o) => o.kind === 'drill' && Math.abs(o.tool.diameter - 3.3) < 0.01)).toBe(true);
    // Every mill feed under the part's bottom (Z-12) within the hole: none (the hole at X0 Y-16 or Y16, the frame centred).
    const under = s.ops
      .filter((o) => o.kind !== 'drill' && o.kind !== 'face')
      .flatMap((o) => o.lines.filter((l) => /^G0?1/.test(l) && Number(l.match(/Z(-?[\d.]+)/)?.[1] ?? 0) < -12 - 0.05 && Math.abs(Number(l.match(/X(-?[\d.]+)/)?.[1] ?? 99)) < 1.65 && Math.abs(Math.abs(Number(l.match(/Y(-?[\d.]+)/)?.[1] ?? 99)) - 16) < 1.65).map((l) => `${o.name} ${l}`));
    expect(under).toEqual([]);
    expect(r.check).toMatchObject({ cales: 0, collisions: 0 });
  }, 600_000);

  it('never sends an end mill down a hole kept for the other side, to what lies under it (you: a mill drilling holes)', () => {
    // 40 x 30 x 12, a Ø4.1 hole through with a Ø6.5 counterbore 3.5 deep from the bottom face; the top up first. The hole
    // is drilled from the counterbore's side (after the turn); the machine has a Ø4 end mill, which fits the hole.
    const tris = plateWithCounterbore(40, 30, 12, { c: [20, 15], d: 4.1, D: 6.5, depth: 3.5 });
    const r = camProgram({ tris, material: 'POM', tools: haasTools, brand: 'HAAS', raw: [44, 34, 19], orient: { side: 'Z+', spin: false }, noNest: true });
    const s = r.setups[0];
    expect(s.side).toBe('Z+');
    // No mill feeds inside the hole under the top in clamping 1 (centred frame: the hole at X0 Y0), the position modal.
    const inside = s.ops
      .filter((o) => o.kind !== 'drill' && o.kind !== 'face')
      .flatMap((o) => {
        let [x, y, z] = [NaN, NaN, NaN];
        return o.lines.flatMap((l) => {
          [x, y, z] = ['X', 'Y', 'Z'].map((a, k) => Number(l.match(new RegExp(`${a}(-?[\\d.]+)`))?.[1] ?? [x, y, z][k]));
          return /^G0?1/.test(l) && z < -0.1 && Math.hypot(x, y) < 2.1 ? [`${o.name} ${l}`] : [];
        });
      });
    expect(inside).toEqual([]);
    expect(r.check.collisions).toBe(0);
  }, 600_000);
});
