import { describe, expect, it } from 'vitest';
import { camProgram } from '../src/lib/cam/program';
import { parseToolpath, speedsFor } from '../src/lib/toolpath';
import { heightPart, plateWithHoles } from './heightPart';

// Shop rule: the part within ±0.1 mm; CAM AI's paths within 0.02 mm of it.
describe('the paths within 0.02 mm of the part', () => {
  it('a hole milled to size: no end mill edge more than 0.02 mm past its wall', () => {
    // A 40x30x10 plate held as it is, a Ø11 hole in the middle (no Ø11 drill: milled). The model's hole is a
    // 48-sided polygon in the Ø11 circle: measured against the circle it stands for (the facets lie 0.012 inside).
    const plate = plateWithHoles(40, 30, 10, [{ c: [20, 15], d: 11 }]);
    const r = camProgram({ tris: plate, material: 'ALU', tools: [], brand: 'HAAS', raw: [40, 30, 15], orient: { side: 'Z+', spin: false } });
    const tp = parseToolpath(r.code, speedsFor('HAAS'));
    let worst = -Infinity;
    let near = 0;
    for (const m of tp.moves) {
      if (m.setup !== 0 || m.kind !== 'feed' || !/FRAESEN|SCHLICHT/.test(m.op ?? '')) continue;
      // The part's middle is the program's X0 Y0 (held as it is, centred); in the hole, under its top.
      for (const p of m.points) {
        if (p[2] > -0.5 || Math.hypot(p[0], p[1]) > 8) continue;
        near++;
        worst = Math.max(worst, Math.hypot(p[0], p[1]) + (m.dia ?? 0) / 2 - 5.5);
      }
    }
    expect(near).toBeGreaterThan(50);
    expect(worst).toBeLessThanOrEqual(0.02);
    // Cut to size, not short of it.
    expect(worst).toBeGreaterThan(-0.02);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
  }, 300_000);

  it('a flat wall roughed to size: the first ring 0.02 mm into it, no more (so a slot of the tool\'s own Ø still has a path)', () => {
    // 40 x 30 x 10 with a 20 x 12 pocket 6 deep, held as it is: walls at X ±10, Y ±6 (the part's middle is X0 Y0).
    const plate = heightPart(Array.from({ length: 30 }, (_, j) => Array.from({ length: 40 }, (_, i) => (i >= 10 && i < 30 && j >= 9 && j < 21 ? 4 : 10))));
    const r = camProgram({ tris: plate, material: 'ALU', tools: [], brand: 'HAAS', raw: [40, 30, 15], orient: { side: 'Z+', spin: false } });
    const tp = parseToolpath(r.code, speedsFor('HAAS'));
    let worst = -Infinity;
    for (const m of tp.moves) {
      if (m.setup !== 0 || m.kind !== 'feed' || !/FRAESEN|SCHLICHT/.test(m.op ?? '')) continue;
      for (const p of m.points) {
        if (p[2] > -0.5 || Math.abs(p[0]) > 10 || Math.abs(p[1]) > 6) continue;
        worst = Math.max(worst, (m.dia ?? 0) / 2 - Math.min(10 - Math.abs(p[0]), 6 - Math.abs(p[1])));
      }
    }
    // 0.01 was tried: a Ø3 could no longer run down a Ø3 slot as modelled (P57135926 +3.2 min with a Ø2.5).
    expect(worst).toBeLessThanOrEqual(0.0205);
    expect(worst).toBeGreaterThan(0);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
  }, 300_000);
});
