import { describe, expect, it } from 'vitest';
import { camProgram, checkProgram } from '../src/lib/cam/program';
import { heightPart } from './heightPart';

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
    expect(checkProgram(plate, planted, 'HAAS', undefined, r.pose).rapids).toBeGreaterThan(0);
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
