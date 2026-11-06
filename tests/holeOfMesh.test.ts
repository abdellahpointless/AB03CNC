import { describe, expect, it } from 'vitest';
import { holeOfMesh } from '../src/lib/measure';

/** A tube's inner wall: radius r along Z from 0 to h, n facets. */
function tube(r: number, h: number, n: number, cx = 5, cy = -3): Float32Array {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    const p = (a: number, z: number) => [cx + r * Math.cos(a), cy + r * Math.sin(a), z];
    out.push(...p(a0, 0), ...p(a1, 0), ...p(a1, h), ...p(a0, 0), ...p(a1, h), ...p(a0, h));
  }
  return Float32Array.from(out);
}

describe('a hole of the model', () => {
  it('fits the circle through the faceted wall clicked', () => {
    const h = holeOfMesh(tube(2.75, 10, 48), 7)!;
    expect(h.r * 2).toBeCloseTo(5.5, 1);
    expect(h.top[0]).toBeCloseTo(5, 2);
    expect(h.top[1]).toBeCloseTo(-3, 2);
    expect(Math.abs(h.top[2] - h.bottom[2])).toBeCloseTo(10, 3);
  });
  it('is no hole on a flat wall', () => {
    const wall = Float32Array.from([0, 0, 0, 10, 0, 0, 10, 0, 5, 0, 0, 0, 10, 0, 5, 0, 0, 5]);
    expect(holeOfMesh(wall, 0)).toBeNull();
  });
});
