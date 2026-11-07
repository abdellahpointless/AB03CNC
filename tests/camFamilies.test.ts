import { describe, expect, it } from 'vitest';
import { camProgram } from '../src/lib/cam/program';
import { heightPart, plateWithHoles } from './heightPart';

const ops = (r: ReturnType<typeof camProgram>) => r.setups.flatMap((s) => s.ops);

describe('part families', () => {
  it('a top plate: its contour finished (semi, finish, spring pass), its lettering engraved, both shown as zones', () => {
    // 60 x 40 x 10, a 20 x 10 pocket 6 deep (the contour the part goes in), an "L" engraved 0.2 deep.
    const L = (i: number, j: number) => (i === 8 && j >= 28 && j <= 34) || (j === 28 && i >= 8 && i <= 12);
    const plate = heightPart(Array.from({ length: 40 }, (_, j) => Array.from({ length: 60 }, (_, i) => (i >= 20 && i < 40 && j >= 15 && j < 25 ? 4 : L(i, j) ? 9.8 : 10))));
    const r = camProgram({ tris: plate, material: 'POM', tools: [], brand: 'HAAS', raw: [64, 44, 14], orient: { side: 'Z+', spin: false }, partType: 'topPlate' });
    const top = r.setups[0];
    expect(top.ops.map((o) => o.purpose)).toEqual(expect.arrayContaining(['face', 'rough', 'contour', 'engrave']));
    // Finishing after all the roughing.
    const kinds = top.ops.map((o) => o.kind);
    expect(kinds.lastIndexOf('pocket')).toBeLessThan(kinds.indexOf('finish'));
    // The pocket's straight wall finished from its top in the finish's own depth per pass (not at
    // every roughing level): 3 rings (semi, finish, spring), each entered once per pass.
    const fin = top.ops.find((o) => o.purpose === 'contour')!;
    const plunges = fin.lines.filter((l) => /^G01 Z/.test(l)).length;
    expect(plunges).toBeLessThanOrEqual(3 * Math.ceil(6 / fin.cut.ap - 1e-6));
    expect(top.zones.map((z) => z.kind).sort()).toEqual(['contour', 'engraving']);
    expect(r.check).toMatchObject({ collisions: 0, holders: 0, rapids: 0 });
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    // Nothing cut out of the part (the finishing runs on the wall, not 0.02 into it).
    expect(r.check.pieces.filter((p) => p.kind === 'cut' && p.mm3 > 2)).toEqual([]);
  }, 900_000);

  it('a seal cage: its 2 mm walls finished gently (half depth, slower feed, faster spindle)', () => {
    // 40 x 40 x 15, a 36 x 36 pocket 12 deep: 2 mm walls.
    const cage = heightPart(Array.from({ length: 40 }, (_, j) => Array.from({ length: 40 }, (_, i) => (i >= 2 && i < 38 && j >= 2 && j < 38 ? 3 : 15))));
    const r = camProgram({ tris: cage, material: 'ALU', tools: [], brand: 'HAAS', raw: [44, 44, 19], orient: { side: 'Z+', spin: false }, partType: 'sealCage' });
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
      ops(camProgram({ tris: plate, material: 'POM', tools: [], brand: 'HAAS', raw: [44, 24, 10], orient: { side: 'Z+', spin: false }, partType }))
        .filter((o) => o.kind === 'drill')
        .map((o) => [o.tool.diameter, o.purpose]);
    expect(drills('pinPlate')).toEqual(expect.arrayContaining([[0.98, 'pinHoles'], [1.97, 'pinHoles'], [2.96, 'pinHoles']]));
    expect(drills('subPlate').map(([d]) => d)).not.toContain(0.98);
  }, 900_000);
});
