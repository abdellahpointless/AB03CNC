import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { stepMesh } from '../src/lib/step';
import { exactFaces, faceEdges, type ExactFace } from '../src/lib/cam/faces';
import { SIDES, sideFeatures } from '../src/lib/cam/features';

// Step 1 of the shape engine (you, 2026-11-27: STEP files always): each face of a STEP model fitted exactly, a plane, a
// cylinder or a cone, with its axis, radius and angle; the holes taken from the exact cylinders. Test parts from
// tools/test-part/make_step_parts.py.
const read = async (name: string) => stepMesh(new Uint8Array(readFileSync(`tests/models/step-${name}.step`)));
const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) <= tol;

describe('the exact faces of a STEP model', () => {
  let angled: { tris: Float32Array; faces: Int32Array };
  let foot: { tris: Float32Array; faces: Int32Array };
  let fa: ExactFace[];
  let ff: ExactFace[];
  beforeAll(async () => {
    [angled, foot] = await Promise.all([read('angled-and-fillets'), read('foot-under-body')]);
    fa = exactFaces(angled.tris, angled.faces);
    ff = exactFaces(foot.tris, foot.faces);
  }, 120_000);

  it('gives every triangle its face', () => {
    expect(angled.faces.length).toBe(angled.tris.length / 9);
    expect(Array.from(angled.faces).every((f) => f >= 0)).toBe(true);
    expect(fa.every((f) => f.kind !== 'other')).toBe(true);
  });

  it('fits holes, counterbores, rounded corners and fillets as cylinders, exactly (inside or outside)', () => {
    const cyl = (r: number, concave: boolean) => fa.filter((f) => f.kind === 'cylinder' && near(f.r!, r) && f.concave === concave);
    expect(cyl(3.3, true).length).toBeGreaterThan(0);
    expect(cyl(5.5, true).length).toBeGreaterThan(0);
    // The pocket's R2 corners (a quarter each, inside) and the block's R3 vertical edges (outside).
    expect(cyl(2, true).length).toBeGreaterThanOrEqual(4);
    expect(cyl(2, true).every((f) => near(f.span!, 90, 1))).toBe(true);
    expect(cyl(3, false).length).toBeGreaterThanOrEqual(3);
    // The 30° slope: a plane, its normal 30° off the vertical.
    expect(fa.some((f) => f.kind === 'plane' && near(Math.abs(f.n[2]), Math.cos(Math.PI / 6)))).toBe(true);
  });

  it('fits a countersink as a cone (45°, inside) and a side notch as a half cylinder', () => {
    const sink = ff.filter((f) => f.kind === 'cone' && f.concave);
    expect(sink).toHaveLength(1);
    expect(sink[0].half!).toBeCloseTo(45, 2);
    expect(ff.some((f) => f.kind === 'cylinder' && near(f.r!, 2.25) && f.concave)).toBe(true);
    expect(ff.some((f) => f.kind === 'cylinder' && near(f.r!, 4) && f.concave && near(f.span!, 180, 1))).toBe(true);
  });

  it('knows which faces meet, and the inside corners (the foot under the body)', () => {
    const e = faceEdges(foot.tris, foot.faces);
    expect(e.length).toBeGreaterThan(ff.length);
    expect(e.some((x) => x.concave)).toBe(true);
    expect(e.some((x) => !x.concave)).toBe(true);
  });

  it('keeps rounded edges out of the chamfers (a vertical R3 edge seen from the side: no graver round it)', () => {
    const y = SIDES.find((s) => s.name === 'Y+')!;
    expect(sideFeatures(angled.tris, y).chamfers.length).toBeGreaterThan(0);
    expect(sideFeatures(angled.tris, y, false, undefined, fa).chamfers).toHaveLength(0);
  });

  it('takes a side\'s holes from the exact cylinders: the Ø6.6 through and its Ø11 counterbore, to the micron', () => {
    const z = SIDES.find((s) => s.name === 'Z+')!;
    const holes = sideFeatures(angled.tris, z, false, undefined, fa).holes;
    const d = holes.map((h) => Math.round(h.r * 2000) / 1000).sort((a, b) => a - b);
    expect(d).toContain(6.6);
    expect(d).toContain(11);
    expect(holes.find((h) => near(h.r, 3.3))!.through).toBe(true);
    expect(holes.find((h) => near(h.r, 5.5))!.top - holes.find((h) => near(h.r, 5.5))!.bottom).toBeCloseTo(6.5, 3);
  });
});
