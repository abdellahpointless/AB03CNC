import { describe, expect, it } from 'vitest';
import { camProgram } from '../src/lib/cam/program';
import { heightPart, plateWithHoles, wallsOf } from './heightPart';

const ops = (r: ReturnType<typeof camProgram>) => r.setups.flatMap((s) => s.ops);

describe('part families', () => {
  it('a top plate: its contour finished in one pass on the wall, its lettering engraved, both shown as zones', () => {
    // 60 x 40 x 10, a 20 x 10 pocket 6 deep (the contour the part goes in), an "L" engraved 0.2 deep.
    const L = (i: number, j: number) => (i === 8 && j >= 28 && j <= 34) || (j === 28 && i >= 8 && i <= 12);
    const plate = heightPart(Array.from({ length: 40 }, (_, j) => Array.from({ length: 60 }, (_, i) => (i >= 20 && i < 40 && j >= 15 && j < 25 ? 4 : L(i, j) ? 9.8 : 10))));
    // The operator picks the pocket's walls to finish.
    const pocket = wallsOf(plate, (x, y) => x > 19 && x < 41 && y > 14 && y < 26);
    const r = camProgram({ tris: plate, material: 'POM', tools: [], brand: 'HAAS', raw: [64, 44, 17], orient: { side: 'Z+', spin: false }, partType: 'topPlate', finish: pocket });
    const top = r.setups[0];
    expect(top.ops.map((o) => o.purpose)).toEqual(expect.arrayContaining(['face', 'rough', 'contour', 'engrave']));
    // Finishing after all the roughing.
    const kinds = top.ops.map((o) => o.kind);
    expect(kinds.lastIndexOf('pocket')).toBeLessThan(kinds.indexOf('finish'));
    // The pocket's straight wall finished from its top in the finish's own depth per pass (not at
    // every roughing level): one ring, entered once per pass.
    const fin = top.ops.find((o) => o.purpose === 'contour')!;
    const plunges = fin.lines.filter((l) => /^G01 Z/.test(l)).length;
    expect(plunges).toBeLessThanOrEqual(Math.ceil(6 / fin.cut.ap - 1e-6));
    expect(top.zones.map((z) => z.kind).sort()).toEqual(['contour', 'engraving']);
    expect(r.check).toMatchObject({ collisions: 0, holders: 0, rapids: 0 });
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    // Nothing cut out of the part (the finishing runs on the wall, not 0.02 into it).
    expect(r.check.pieces.filter((p) => p.kind === 'cut' && p.mm3 > 2)).toEqual([]);
  }, 900_000);

  it('a top plate: only the walls the operator picked are finished; none picked, none finished', () => {
    // 60 x 40 x 10, two 15 x 20 pockets 6 deep: A on the left (x 10-25), B on the right (x 35-50). A's walls picked.
    const two = heightPart(Array.from({ length: 40 }, (_, j) => Array.from({ length: 60 }, (_, i) => (j >= 10 && j < 30 && ((i >= 10 && i < 25) || (i >= 35 && i < 50)) ? 4 : 10))));
    const input = { tris: two, material: 'POM', tools: [], brand: 'HAAS', raw: [64, 44, 17] as [number, number, number], orient: { side: 'Z+', spin: false }, partType: 'topPlate' as const, noNest: true };
    const a = camProgram({ ...input, finish: wallsOf(two, (x, y) => x > 9 && x < 26 && y > 9 && y < 31) });
    const fin = a.setups[0].ops.filter((o) => o.kind === 'finish');
    expect(fin.length).toBeGreaterThan(0);
    // The part's middle is X0: A's walls lie at X -20 to -5, B's at 5 to 20. Every finishing move is at A.
    const xs = fin.flatMap((o) => o.lines.flatMap((l) => (/^G0[123]\b.*X/.test(l) ? [Number(l.match(/X(-?[\d.]+)/)![1])] : [])));
    expect(xs.length).toBeGreaterThan(0);
    expect(Math.max(...xs)).toBeLessThan(0);
    expect(a.check).toMatchObject({ collisions: 0, holders: 0, rapids: 0 });
    expect(a.check.match).toBeGreaterThanOrEqual(0.99);
    // Nothing picked: no finishing pass at all, the walls roughed to size.
    const none = camProgram(input);
    expect(ops(none).filter((o) => o.kind === 'finish')).toEqual([]);
    expect(none.check.match).toBeGreaterThanOrEqual(0.99);
  }, 900_000);

  it('a top plate\'s white face (the operator\'s pick) is never faced: all the Z stock comes off the other side', () => {
    // 40 x 30 x 10 with a 20 x 12 pocket 6 deep, a blank 7 mm thicker.
    const plate = heightPart(Array.from({ length: 30 }, (_, j) => Array.from({ length: 40 }, (_, i) => (i >= 10 && i < 30 && j >= 9 && j < 21 ? 4 : 10))));
    for (const white of ['Z+', 'Z-']) {
      const r = camProgram({ tris: plate, material: 'FH', tools: [], brand: 'HAAS', raw: [44, 34, 17], partType: 'topPlate', noNest: true, white });
      // The blank flush with the white face, all 7 mm on the other side.
      if (white === 'Z+') expect(r.blank.hi[2]).toBeCloseTo(5, 5);
      else expect(r.blank.lo[2]).toBeCloseTo(-5, 5);
      const up = r.setups.find((s) => s.side === white)!;
      expect(up, white).toBeTruthy();
      expect(up.ops.map((o) => o.kind)).not.toContain('face');
      expect(r.setups.find((s) => s.side === (white === 'Z+' ? 'Z-' : 'Z+'))!.ops.map((o) => o.kind)).toContain('face');
      expect(r.check).toMatchObject({ collisions: 0, holders: 0, rapids: 0 });
      expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    }
  }, 900_000);

  it('a seal cage: its 2 mm walls finished gently (half depth, slower feed, faster spindle)', () => {
    // 40 x 40 x 15, a 36 x 36 pocket 12 deep: 2 mm walls.
    const cage = heightPart(Array.from({ length: 40 }, (_, j) => Array.from({ length: 40 }, (_, i) => (i >= 2 && i < 38 && j >= 2 && j < 38 ? 3 : 15))));
    const r = camProgram({ tris: cage, material: 'ALU', tools: [], brand: 'HAAS', raw: [44, 44, 19.5], orient: { side: 'Z+', spin: false }, partType: 'sealCage' });
    const thin = ops(r).filter((o) => o.purpose === 'thinWalls');
    expect(thin.length).toBeGreaterThan(0);
    // The gentle rings run the spindle faster than the finishing's own speed.
    expect(thin.some((o) => o.lines.some((l) => /^S\d+$/.test(l) && Number(l.slice(1)) > o.cut.s))).toBe(true);
    expect(r.setups[0].zones.some((z) => z.kind === 'thinWall')).toBe(true);
    expect(r.check).toMatchObject({ collisions: 0, holders: 0, rapids: 0 });
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
  }, 900_000);

  it('a pin plate: the Ø1, Ø2, Ø3 holes drilled 0.98, 1.97, 2.96; a sub plate keeps the plain drills', () => {
    const plate = plateWithHoles(40, 20, 8, [{ c: [8, 10], d: 1 }, { c: [20, 10], d: 2 }, { c: [32, 10], d: 3 }]);
    const drills = (partType: 'pinPlate' | 'subPlate') =>
      ops(camProgram({ tris: plate, material: 'POM', tools: [], brand: 'HAAS', raw: [44, 24, 13], orient: { side: 'Z+', spin: false }, partType }))
        .filter((o) => o.kind === 'drill')
        .map((o) => [o.tool.diameter, o.purpose]);
    expect(drills('pinPlate')).toEqual(expect.arrayContaining([[0.98, 'pinHoles'], [1.97, 'pinHoles'], [2.96, 'pinHoles']]));
    expect(drills('subPlate').map(([d]) => d)).not.toContain(0.98);
  }, 900_000);
});
