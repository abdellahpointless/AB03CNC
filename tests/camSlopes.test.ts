import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stepMesh } from '../src/lib/step';
import { exactFaces, faceEdges } from '../src/lib/cam/faces';
import { slopePasses, slopesOf } from '../src/lib/cam/slopes';
import { camProgram } from '../src/lib/cam/program';
import { haas1Tools } from '../src/lib/defaultTools';

// You (2026-11-27): a flat slope is cut from the top with a ball end mill, not by clampings on its side (the angled test
// part: a 30° slope over the last 10 mm of its X+ end, 5 clampings before, the slope cut from Y+, Y- and X+ as a wall).
const read = async (name: string) => stepMesh(new Uint8Array(readFileSync(`tests/models/step-${name}.step`)));

describe('flat slopes', () => {
  it('finds the slope a side sees from above, and no other face', async () => {
    const { tris, faces } = await read('angled-and-fillets');
    const s = slopesOf(tris, exactFaces(tris, faces), faceEdges(tris, faces));
    expect(s).toHaveLength(1);
    expect(s[0].n[0]).toBeCloseTo(0.5, 4);
    expect(s[0].n[2]).toBeCloseTo(Math.sqrt(3) / 2, 4);
    // Its ball passes: each at one Z, 0.01 mm scallops apart, over its whole width (Y 0..30) and 1 mm past it.
    const p = slopePasses(tris, s[0], 3, 0.01);
    expect(p.length).toBeGreaterThan(20);
    expect(p.every((x) => Math.abs(x.a[0] - x.b[0]) < 1e-6)).toBe(true);
    // The first along its top edge (X 30, Z 20): the ball's centre 3 mm out along the normal, its tip 3 mm under that.
    expect(p[0].a[0]).toBeCloseTo(31.5, 1);
    expect(p[0].z).toBeCloseTo(20 + 3 * Math.sqrt(3) / 2 - 3, 1);
    expect(Math.min(p[0].a[1], p[0].b[1])).toBeLessThan(0);
    expect(Math.max(p[0].a[1], p[0].b[1])).toBeGreaterThan(30);
    for (const name of ['fin', 'foot-under-body', 'teeth']) {
      const m = await read(name);
      expect(slopesOf(m.tris, exactFaces(m.tris, m.faces), faceEdges(m.tris, m.faces)), name).toEqual([]);
    }
  }, 120_000);

  it('cuts it from the top in the clamping that sees it, with the machine\'s ball end mill: 2 clampings, nothing cut into the part', async () => {
    const { tris, faces } = await read('angled-and-fillets');
    const r = camProgram({ material: 'MS', tools: haas1Tools, brand: 'HAAS', orient: { side: 'Z+', spin: false }, tris, faces, raw: [44, 34, 28.5] });
    expect(r.setups.map((x) => x.side)).toEqual(['Z+', 'Z-']);
    const ball = r.setups[0].ops.find((o) => o.purpose === 'slope');
    expect(ball?.tool.type).toBe('KF');
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
    expect(r.check.misplaced).toBe(0);
    expect(Math.max(0, ...r.check.pieces.filter((p) => p.kind === 'cut').map((p) => p.mm3))).toBeLessThan(5);
  }, 600_000);
});
