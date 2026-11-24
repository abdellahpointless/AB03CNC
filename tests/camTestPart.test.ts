import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SIDES, sideFeatures } from '../src/lib/cam/features';
import { readTris } from '../src/lib/model';

// CAM AI's test part (tools/test-part/make_test_part.py, docs/knowledge/cam-test-part.md): one block with every kind of
// operation. Planning it takes minutes, so this checks what CAM AI reads from it; the plan's baseline is in the doc.
const load = async () => {
  const tris = await readTris(new Uint8Array(readFileSync('tests/models/cam-test-part.stl')));
  if ('error' in tris) throw new Error(tris.error);
  return tris;
};
const side = (name: string) => SIDES.find((s) => s.name === name)!;
const holes = (f: ReturnType<typeof sideFeatures>) => f.holes.map((h) => `Ø${(h.r * 2).toFixed(1)} ${h.through ? 'through' : `${(h.top - h.bottom).toFixed(1)} deep`}`).sort();

describe('CAM AI test part', () => {
  it('is a closed 100 x 60 x 30 mesh, every edge shared by two faces running opposite ways', async () => {
    const tris = await load();
    const size = [0, 1, 2].map((k) => {
      let [lo, hi] = [Infinity, -Infinity];
      for (let i = k; i < tris.length; i += 3) [lo, hi] = [Math.min(lo, tris[i]), Math.max(hi, tris[i])];
      return Math.round((hi - lo) * 1000) / 1000;
    });
    expect(size).toEqual([100, 60, 30]);
    const key = (i: number) => `${tris[i].toFixed(4)},${tris[i + 1].toFixed(4)},${tris[i + 2].toFixed(4)}`;
    const edges = new Map<string, number>();
    for (let t = 0; t < tris.length; t += 9)
      for (const [a, b] of [[0, 3], [3, 6], [6, 0]]) {
        const e = `${key(t + a)}|${key(t + b)}`;
        edges.set(e, (edges.get(e) ?? 0) + 1);
      }
    const open = [...edges].filter(([e, n]) => {
      const [a, b] = e.split('|');
      return n !== 1 || edges.get(`${b}|${a}`) !== 1;
    });
    expect(open).toEqual([]);
  });

  it('reads every hole, from the side it is made from', async () => {
    const tris = await load();
    expect(holes(sideFeatures(tris, side('Z+')))).toEqual(
      ['Ø3.3 through', 'Ø4.2 through', 'Ø5.0 through', 'Ø6.8 through', 'Ø5.0 15.0 deep', 'Ø10.0 8.0 deep', 'Ø11.0 6.5 deep', 'Ø6.6 through', 'Ø6.4 through', 'Ø13.0 through', 'Ø5.5 25.0 deep'].sort(),
    );
    // From the bottom: the counterbore and its hole through.
    expect(holes(sideFeatures(tris, side('Z-')))).toEqual(expect.arrayContaining(['Ø10.0 5.0 deep', 'Ø5.5 through']));
    expect(holes(sideFeatures(tris, side('Y+')))).toEqual(['Ø6.0 15.0 deep']);
  });

  it('reads the floors, the chamfers and the 3D surface', async () => {
    const tris = await load();
    const top = sideFeatures(tris, side('Z+'));
    const depths = (f: ReturnType<typeof sideFeatures>) => f.floors.filter((x) => x.area > 5).map((x) => Math.round((f.max[2] - x.z) * 10) / 10);
    // The slot 6, the step and the pocket 12 (the island's top 4), the flat-bottomed hole 8.
    expect(depths(top)).toEqual(expect.arrayContaining([4, 6, 8, 12]));
    expect(top.chamfers.length).toBeGreaterThan(0);
    expect(top.freeform).toBeGreaterThan(20);
    expect(depths(sideFeatures(tris, side('Z-')))).toEqual(expect.arrayContaining([5, 8]));
    expect(depths(sideFeatures(tris, side('Y-')))).toContain(6);
  });
});
