import { describe, expect, it } from 'vitest';
import hateUrl from './models/O2504411.pdf?inline';
import plateUrl from './models/O1042013.pdf?inline';
import pinUrl from './models/O0106607.stl?inline';
import { readModel } from '../src/lib/model';
import { SIDES, sideFeatures } from '../src/lib/cam/features';
import { area, intersection, offset, slice, turnTris } from '../src/lib/cam/geom';

const bytes = (url: string) => Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (c) => c.charCodeAt(0));
const side = (n: string) => SIDES.find((s) => s.name === n)!;
const count = (holes: { r: number }[], d: number) => holes.filter((h) => Math.abs(h.r * 2 - d) < 0.05).length;

describe('features of a part from its 3D model', () => {
  it('O2504411: the M3 core holes through from the side, the Ø3.2 holes from the top', async () => {
    const tris = await readModel(bytes(hateUrl));
    const x = sideFeatures(tris, side('X+'));
    expect(count(x.holes, 2.46)).toBe(4);
    expect(x.holes.every((h) => h.through && h.closed)).toBe(true);
    const z = sideFeatures(tris, side('Z+'));
    expect(count(z.holes, 3.2)).toBe(2);
    expect(z.max[2] - z.min[2]).toBeCloseTo(9, 2);
  });
  it('O1042013: its floors, holes and the 0.8 mm top chamfer from the top, the counterbores from below', async () => {
    const tris = await readModel(bytes(plateUrl));
    const z = sideFeatures(tris, side('Z+'));
    expect(z.floors[0].z).toBeCloseTo(z.max[2], 2);
    expect(z.floors.map((f) => f.z)).toEqual(expect.arrayContaining([-1.8, -4]));
    expect(count(z.holes, 4.8)).toBe(4);
    // The Ø8 bores sit under the Ø4.8 holes: counterbores from below, never drilled through the
    // Ø4.8 from the top.
    expect(count(z.holes, 8)).toBe(0);
    expect(count(sideFeatures(tris, side('Z-')).holes, 8)).toBe(6);
    expect(z.chamfers.some((c) => Math.abs(c.hi - c.lo - 0.8) < 0.02 && c.hi === 0)).toBe(true);
  });
  it('cuts the model into outlines and offsets them by a tool radius', async () => {
    const tris = await readModel(bytes(hateUrl));
    const r = slice(tris, 4.5);
    expect(area(r)).toBeGreaterThan(300);
    expect(area(offset(r, 1))).toBeGreaterThan(area(r));
    expect(area(offset(r, -0.5))).toBeLessThan(area(r));
  });
  it('O0106607: a Ø5 bore under a Ø2.6 neck is not drilled from the neck side (it would cut the neck away)', async () => {
    const tris = await readModel(bytes(pinUrl));
    const disk = (c: [number, number], r: number) => [Array.from({ length: 32 }, (_, i) => [c[0] + r * Math.cos((i * Math.PI) / 16), c[1] + r * Math.sin((i * Math.PI) / 16)] as [number, number])];
    let checked = 0;
    for (const s of SIDES) {
      const f = sideFeatures(tris, s);
      const P = turnTris(tris, f.R);
      // Over every hole found, its whole circle is free of the part up to the top.
      for (const h of f.holes)
        for (let z = h.top + 0.1; z < f.max[2] - 0.05; z += 0.25, checked++) expect(area(intersection(slice(P, z), disk(h.c, h.r - 0.05)))).toBeLessThan(0.01);
    }
    expect(checked).toBeGreaterThan(0);
  });
});
