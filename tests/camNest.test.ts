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

describe('a tall part the vise cannot hold against the big mills', () => {
  // The engineers hold the study's part standing 70 tall in the vise, 37 mm deep, cutting it with a Ø6 at most (21 N
  // of push); CAM AI cut it with its Ø20 (430 N) and, the vise check refusing that, put it in the nest on 38 mm
  // parallels. A smaller mill (its push falls about with its Ø squared) before the nest.
  it('takes the largest smaller mill the vise holds at half feed or more (push about Ø squared)', async () => {
    const { lighterMill } = await import('../src/lib/cam/program');
    const set = [20, 16, 12, 10, 8, 6, 5, 4, 3];
    // Held at 12 % of the Ø20's feed: up to 20·√(0.12/0.5) = 9.8, the Ø8.
    expect(lighterMill(set, 20, 0.12)).toBe(8);
    // At half or more: no lighter mill.
    expect(lighterMill(set, 20, 0.6)).toBeUndefined();
    // Nothing smaller to take.
    expect(lighterMill([20], 20, 0.1)).toBeUndefined();
  });

  it('is held in the vise with smaller mills, not in the nest (POM block 20 x 40, 70 tall, a pocket in its top)', async () => {
    const { camProgram } = await import('../src/lib/cam/program');
    const { heightPart } = await import('./heightPart');
    const tall = heightPart(Array.from({ length: 40 }, (_, j) => Array.from({ length: 20 }, (_, i) => (i >= 5 && i < 15 && j >= 8 && j < 32 ? 50 : 70))));
    const r = camProgram({ tris: tall, material: 'POM', tools: [], brand: 'HAAS', raw: [24, 44, 77], orient: { side: 'Z+', spin: false } });
    expect(r.setups.filter((s) => s.nest)).toEqual([]);
    for (const s of r.setups) {
      expect(s.physics.ok).toBe(true);
      expect(Math.max(...s.ops.filter((o) => o.kind === 'pocket').map((o) => o.tool.diameter))).toBeLessThan(20);
    }
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
  }, 900_000);
});

describe('the nest stays under the face the face mill cuts', () => {
  it('nests no clamping whose nest would stand within 0.5 mm of the face, and does not prove a plate too thin for the vise (a review found a 3.4 mm plate nested, the face mill over its set screws)', async () => {
    const { camProgram } = await import('../src/lib/cam/program');
    const { heightPart } = await import('./heightPart');
    // As the page plans it: the operator's layout, the nest allowed.
    for (const [h, material] of [[3.4, 'ALU'], [4, 'POM']] as const) {
      const plate = heightPart(Array.from({ length: 25 }, (_, j) => Array.from({ length: 40 }, (_, i) => (i % 10 >= 3 && i % 10 < 7 && j % 10 >= 3 && j % 10 < 7 ? 1 : h))));
      const r = camProgram({ tris: plate, material, tools: [], brand: 'HAAS', raw: [44, 30, h + 10], orient: { side: 'Z+', spin: false } });
      for (const s of r.setups.filter((x) => x.nest)) expect(s.nest!.min[2] + s.nest!.size[2], `${h} mm, ${s.side}`).toBeLessThanOrEqual(-0.5 + 1e-6);
      expect(r.setups.every((s) => s.physics.ok), `${h} mm`).toBe(false);
    }
  }, 900_000);
});
