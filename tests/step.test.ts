import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readModel } from '../src/lib/model';
import { isStep } from '../src/lib/step';

// STEP models (OpenCascade's test cubes, saved in mm and in inches): read as triangles in mm, like a 3D PDF or STL.
const box = (t: Float32Array) =>
  [0, 1, 2].map((k) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = k; i < t.length; i += 3) [lo, hi] = [Math.min(lo, t[i]), Math.max(hi, t[i])];
    return hi - lo;
  });

describe('STEP models', () => {
  it('reads a STEP cube as triangles in mm, whatever unit the file uses', async () => {
    const mm = new Uint8Array(readFileSync('tests/models/cube-mm.step'));
    const inch = new Uint8Array(readFileSync('tests/models/cube-in.step'));
    expect(isStep(mm)).toBe(true);
    const a = await readModel(mm);
    const b = await readModel(inch);
    expect(a.length % 9).toBe(0);
    expect(a.length / 9).toBeGreaterThanOrEqual(12);
    // The same 1 m cube, written in mm in one file and in inches in the other.
    for (const v of [...box(a), ...box(b)]) expect(v).toBeCloseTo(1000, 2);
  }, 60_000);

  it('does not take an STL or a PDF for a STEP file', () => {
    expect(isStep(new TextEncoder().encode('solid part\nfacet normal 0 0 1'))).toBe(false);
    expect(isStep(new TextEncoder().encode('%PDF-1.7'))).toBe(false);
  });
});
