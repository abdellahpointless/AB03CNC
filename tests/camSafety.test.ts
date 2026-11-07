import { describe, expect, it } from 'vitest';
import { camProgram, checkProgram } from '../src/lib/cam/program';
import { heightPart, plateWithHoles } from './heightPart';

// A 40x30x12 plate with a 20x12 pocket 6 deep in its top.
const plate = heightPart(Array.from({ length: 30 }, (_, j) => Array.from({ length: 40 }, (_, i) => (i >= 10 && i < 30 && j >= 9 && j < 21 ? 6 : 12))));

describe('the safety double check', () => {
  const r = camProgram({ tris: plate, material: 'ALU', tools: [], brand: 'HAAS', raw: [44, 34, 16], orient: { side: 'Z+', spin: false } });
  const lines = r.code.split('\n');

  it("CAM AI's own program: no holder in the material, no rapid through it", () => {
    expect(r.check).toMatchObject({ holders: 0, rapids: 0, collisions: 0 });
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
  });

  it('catches a rapid planted through the stock', () => {
    // Straight across the plate 3 mm down, at rapid, before the first end mill starts cutting.
    const at = lines.findIndex((l) => /TOOLPATH FRAESEN/.test(l));
    const start = lines.findIndex((l, i) => i > at && /G00 G90 X/.test(l));
    const planted = [...lines.slice(0, start + 1), 'N9 G00 Z-3.', 'N9 G00 X60.', ...lines.slice(start + 1)].join('\n');
    const check = checkProgram(plate, planted, 'HAAS', undefined, r.pose);
    expect(check.rapids).toBeGreaterThan(0);
    // Straight down into the solid stock and across it: never taken for a graze (never run at feed).
    expect(check.grazes).toEqual([]);
  }, 300_000);

  it('catches a holder planted in the part (a tool typed too short for its depth)', () => {
    // The first end mill typed 2 mm long: its holder goes down into the pocket's walls.
    const at = lines.findIndex((l) => /TOOLPATH FRAESEN/.test(l));
    const len = lines.findIndex((l, i) => i > at && /LENGTH [\d.]+ MM/.test(l));
    const planted = lines.map((l, i) => (i === len ? l.replace(/LENGTH [\d.]+ MM/, 'LENGTH 2.00 MM') : l)).join('\n');
    const c = checkProgram(plate, planted, 'HAAS', undefined, r.pose);
    expect(c.holders).toBeGreaterThan(0);
    expect(c.collisions).toBeGreaterThan(0);
  }, 300_000);
});

describe('no tool into a parallel (shop rule for CAM AI)', () => {
  it('a narrow plate with a hole milled through over the front parallel: the cut stops on it', () => {
    // 40 x 9 x 5.5, a Ø4.5 hole through it near the front edge: the parallels under the front and
    // back edges, the hole's milling over the front one (46 hits if it went 0.2 below the part).
    const holed = plateWithHoles(40, 9, 5.5, [{ c: [20, 2.6], d: 4.5 }]);
    const r = camProgram({ tris: holed, material: 'POM', tools: [], brand: 'HAAS', raw: [40, 9, 5.5], orient: { side: 'Z+', spin: false } });
    expect(r.check).toMatchObject({ cales: 0, collisions: 0, holders: 0, rapids: 0 });
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
  }, 900_000);
});
