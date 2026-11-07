import { describe, expect, it } from 'vitest';
import { NEST, nestFor } from '../src/lib/cam/nest';
import { SIDES, sideFeatures } from '../src/lib/cam/features';

/** Signed volume of a closed mesh (positive when its normals face out). */
function volume(t: Float32Array) {
  let v = 0;
  for (let i = 0; i < t.length; i += 9)
    v += (t[i] * (t[i + 4] * t[i + 8] - t[i + 5] * t[i + 7]) - t[i + 1] * (t[i + 3] * t[i + 8] - t[i + 5] * t[i + 6]) + t[i + 2] * (t[i + 3] * t[i + 7] - t[i + 4] * t[i + 6])) / 6;
  return v;
}

describe('the POM nest (last way to hold a part)', () => {
  // A 40 x 20 part, its bottom at -12, in a pocket 8 deep.
  const n = nestFor([-20, -10], [20, 10], -12, 8);

  it('a block round the part: 12 mm walls, an 8 mm floor, the pocket 0.1 mm over the part', () => {
    expect(n.size.map((v) => Math.round(v * 100) / 100)).toEqual([64.2, 44.2, 16]);
    expect(n.pocket).toEqual({ lo: [-20.1, -10.1], hi: [20.1, 10.1], depth: 8 });
    // The X- wall runs along Y (20 mm): one screw; the Y- wall along X (40 mm): two.
    expect(n.screws.map((s) => s.face)).toEqual(['X-', 'Y-', 'Y-']);
    expect(n.screws.every((s) => s.at[2] === -8)).toBe(true);
  });

  it('is a closed mesh, every edge shared by two faces running opposite ways', () => {
    const key = (i: number) => `${n.tris[i]},${n.tris[i + 1]},${n.tris[i + 2]}`;
    const edges = new Map<string, number>();
    for (let t = 0; t < n.tris.length; t += 9)
      for (let e = 0; e < 3; e++) {
        const k = `${key(t + e * 3)}|${key(t + ((e + 1) % 3) * 3)}`;
        edges.set(k, (edges.get(k) ?? 0) + 1);
      }
    for (const [k, count] of edges) {
      const [a, b] = k.split('|');
      expect(count).toBe(1);
      expect(edges.get(`${b}|${a}`)).toBe(1);
    }
  });

  it('its volume is the block less the pocket and the screw holes', () => {
    const block = 64.2 * 44.2 * 16 - 40.2 * 20.2 * 8;
    // 24-sided holes through the 12 mm walls.
    const hole = (24 / 2) * (NEST.tapDrill / 2) ** 2 * Math.sin((2 * Math.PI) / 24) * 12;
    expect(volume(n.tris)).toBeCloseTo(block - 3 * hole, 1);
  });

  it('CAM AI sees the pocket from the top and the screw holes from the sides', () => {
    const z = sideFeatures(n.tris, SIDES.find((s) => s.name === 'Z+')!);
    // The block's top (-4) and the pocket floor, where the part sits (-12).
    expect(z.floors.map((f) => Math.round(f.z * 100) / 100)).toEqual([-4, -12]);
    const x = sideFeatures(n.tris, SIDES.find((s) => s.name === 'X-')!);
    expect(x.holes.filter((h) => Math.abs(h.r * 2 - NEST.tapDrill) < 0.05)).toHaveLength(1);
    const y = sideFeatures(n.tris, SIDES.find((s) => s.name === 'Y-')!);
    expect(y.holes.filter((h) => Math.abs(h.r * 2 - NEST.tapDrill) < 0.05)).toHaveLength(2);
  });
});

describe('CAM AI falls back on the nest only when no way of holding passes', () => {
  it('a POM pin 8 x 8 standing 60 tall: held in a nest, read back and simulated right', async () => {
    const { camProgram } = await import('../src/lib/cam/program');
    const { heightPart } = await import('./heightPart');
    const pin = heightPart(Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => 60)));
    const r = camProgram({ tris: pin, material: 'POM', tools: [], brand: 'HAAS', raw: [10, 10, 62], orient: { side: 'Z+', spin: false } });
    const nested = r.setups.filter((s) => s.nest);
    expect(nested.length).toBeGreaterThan(0);
    for (const s of nested) {
      expect(s.notes.join(' / ')).toMatch(/TEIL IN POM-NEST LEGEN/);
      expect(s.physics.ok).toBe(true);
      expect(s.physics.issues[0]).toMatchObject({ key: 'nest' });
    }
    // The checker reads the nest (walls off the stop and the fixed jaw, its floor) and the part comes out right.
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
    // The nest has its own program, right too.
    expect(r.nests?.length).toBe(nested.length);
    for (const n of r.nests!) {
      expect(n.check.match).toBeGreaterThanOrEqual(0.99);
      expect(n.check.collisions).toBe(0);
    }
  }, 900_000);
});
