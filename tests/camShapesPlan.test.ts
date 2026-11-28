import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stepMesh } from '../src/lib/step';
import { camProgram } from '../src/lib/cam/program';
import { haasTools } from '../src/lib/defaultTools';
import { bounds } from '../src/lib/cam/geom';
import { exactFaces } from '../src/lib/cam/faces';
import { SIDES, sideFeatures } from '../src/lib/cam/features';
import { recognizeFaces } from '../src/lib/cam/recognize';

/** Phase 3, step 1: every shape of a STEP model checked against the simulated program; one left uncut is named. */
const plan = async (name: string, material = 'MS') => {
  const { tris, faces } = await stepMesh(new Uint8Array(readFileSync(`tests/models/${name}.step`)));
  const b = bounds(tris);
  const raw = [0, 1, 2].map((k) => b.max[k] - b.min[k] + (k === 2 ? 8.5 : 4)) as [number, number, number];
  return camProgram({ material, tools: haasTools, brand: 'HAAS', orient: { side: 'Z+', spin: false }, tris, faces, raw });
};
const shapeNotes = (r: Awaited<ReturnType<typeof plan>>) => r.notes.filter((n) => n.key === 'shapeLeft' || n.key === 'shapeNoReach');

describe('the program against the model’s shapes', () => {
  it('a part it cuts whole: no shape named', async () => {
    const r = await plan('feat-pocket-hole');
    expect(r.check.match).toBeGreaterThan(0.999);
    expect(shapeNotes(r)).toEqual([]);
  }, 120_000);
  it('holes at an angle: each named as no straight tool reaching it, the general undercut note dropped', async () => {
    const r = await plan('feat-tilted-holes');
    expect(shapeNotes(r).map(({ key, shape, size, side }) => ({ key, shape, size, side }))).toEqual([
      { key: 'shapeNoReach', shape: 'hole', size: 'Ø6 × 23.1', side: '' },
      { key: 'shapeNoReach', shape: 'hole', size: 'Ø5 × 8', side: '' },
    ]);
    expect(r.notes.some((n) => n.key === 'undercut')).toBe(false);
  }, 120_000);
  it('a blind T-slot: its wings (no T-slot cutter here) named on the T-slot', async () => {
    const [n] = shapeNotes(await plan('feat-blind-t-slot'));
    expect({ key: n.key, shape: n.shape, size: n.size, side: n.side }).toEqual({ key: 'shapeLeft', shape: 'tslot', size: '40 × 14 × 12', side: 'Z+' });
    expect(n.mm3).toBeGreaterThan(1800);
  }, 120_000);
});

describe('phase 3: holes from the shapes, a ball end mill for round 3D shapes', () => {
  it('3.2: a keyway’s round end is no hole (the cylinder finder took it for one); a hole a slot cuts in two is drilled whole', async () => {
    const { tris, faces } = await stepMesh(new Uint8Array(readFileSync('tests/models/feat-open-slots.step')));
    const exact = exactFaces(tris, faces);
    const shapes = recognizeFaces(tris, faces, exact).features;
    const z = SIDES.find((x) => x.name === 'Z+')!;
    expect(sideFeatures(tris, z, false, undefined, exact).holes.length).toBeGreaterThan(0);
    expect(sideFeatures(tris, z, false, undefined, exact, shapes).holes).toEqual([]);
    const r = await plan('feat-slot-cross-holes');
    expect(r.check.match).toBeGreaterThan(0.999);
    expect(shapeNotes(r)).toEqual([]);
  }, 180_000);
  it('3.4: the ball’s recess cut by a ball end mill, nothing cut that the part has; round the cone pin in its tight pocket as far as the ball goes, the rest (and the taper) named', async () => {
    // POM: HAAS-1's ball end mills are the plastics' (its aluminium tools have none).
    const r = await plan('feat-cones-balls', 'POM');
    expect(r.setups.flatMap((s) => s.ops).some((o) => o.purpose === 'slope' && o.name.startsWith('KUGEL'))).toBe(true);
    expect(r.check.pieces.filter((p) => p.kind === 'cut')).toEqual([]);
    expect(shapeNotes(r).map((n) => n.shape).sort()).toEqual(['cone', 'taper']);
  }, 180_000);
});

describe('the owner’s tool rules (2026-11-28)', () => {
  it('countersinks of 60° and 100°: made with the 90° graver, the difference accepted, nothing named', async () => {
    const r = await plan('feat-countersinks', 'POM');
    expect(r.setups.flatMap((s) => s.ops).some((o) => o.name === 'FASE')).toBe(true);
    expect(r.setups.some((s) => s.sunk?.length)).toBe(true);
    expect(r.check.pieces).toEqual([]);
    expect(shapeNotes(r)).toEqual([]);
  }, 180_000);
  it('aluminium: no ball end mill asked for, no ball shape cut (the admin adds one to have them)', async () => {
    const r = await plan('feat-cones-balls', 'ALU');
    expect(r.setups.flatMap((s) => s.ops).some((o) => o.name.startsWith('KUGEL'))).toBe(false);
    expect(r.missing.some((m) => m.category === 'fraise boule')).toBe(false);
  }, 180_000);
});
