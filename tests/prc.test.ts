import { describe, expect, it } from 'vitest';
import pdfUrl from './models/O2504411.pdf?inline';
import stlUrl from './models/O2504411.stl?inline';
import { readModel, readStl } from '../src/lib/model';

const bytes = (url: string) => Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (c) => c.charCodeAt(0));
const box = (t: Float32Array) => [0, 1, 2].map((k) => {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = k; i < t.length; i += 3) (lo = Math.min(lo, t[i])), (hi = Math.max(hi, t[i]));
  return [lo, hi];
});

describe('the model inside a 3D PDF', () => {
  it('reads the same triangles as the STL exported with it (O2504411)', async () => {
    const pdf = await readModel(bytes(pdfUrl));
    const stl = readStl(bytes(stlUrl));
    expect(pdf.length).toBe(stl.length);
    // In mm (the PDF stores metres), on the same spot.
    box(pdf).forEach(([lo, hi], k) => {
      expect(lo).toBeCloseTo(box(stl)[k][0], 3);
      expect(hi).toBeCloseTo(box(stl)[k][1], 3);
    });
    // The same vertices, in any order.
    const key = (t: Float32Array) => Array.from({ length: t.length / 3 }, (_, i) => `${t[i * 3].toFixed(3)},${t[i * 3 + 1].toFixed(3)},${t[i * 3 + 2].toFixed(3)}`).sort();
    expect(key(pdf)).toEqual(key(stl));
  });
  it('says so when a PDF has no 3D model', async () => {
    await expect(readModel(new TextEncoder().encode('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF'))).rejects.toThrow(/no 3D model/);
  });
});
