import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stepMesh } from '../src/lib/step';
import { camProgram } from '../src/lib/cam/program';
import { haasTools } from '../src/lib/defaultTools';
import { bounds } from '../src/lib/cam/geom';

/** Phase 3, step 1: every shape of a STEP model checked against the simulated program; one left uncut is named. */
const plan = async (name: string) => {
  const { tris, faces } = await stepMesh(new Uint8Array(readFileSync(`tests/models/${name}.step`)));
  const b = bounds(tris);
  const raw = [0, 1, 2].map((k) => b.max[k] - b.min[k] + (k === 2 ? 8.5 : 4)) as [number, number, number];
  return camProgram({ material: 'MS', tools: haasTools, brand: 'HAAS', orient: { side: 'Z+', spin: false }, tris, faces, raw });
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
