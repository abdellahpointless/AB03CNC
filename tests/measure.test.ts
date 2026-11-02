import { describe, expect, it } from 'vitest';
import { between, holeAt, placeDimension, type Feature } from '../src/lib/measure';
import type { Hole } from '../src/lib/stockSim';

// A 100 x 50 x 30 part; a Ø6.4 hole 12 deep at (20, 25) from the top, and a Ø8 at (70, 25).
const box = { min: [0, 0, 0] as [number, number, number], max: [100, 50, 30] as [number, number, number] };
const hole = (x: number, r: number, depth: number): Hole => ({ top: [x, 25, 30], bottom: [x, 25, 30 - depth], r, tool: 1, move: 0, flat: true, closed: true });
const holes = [hole(20, 3.2, 12), hole(70, 4, 20)];
const top: Feature = { kind: 'face', axis: 2, at: 30, sign: 1, p: [50, 10, 30] };
const bottom: Feature = { kind: 'face', axis: 2, at: 0, sign: -1, p: [40, 40, 0] };
const left: Feature = { kind: 'face', axis: 0, at: 0, sign: -1, p: [0, 20, 15] };

describe('measuring features', () => {
  it('finds the hole from a click on its wall or right next to its rim, and nothing elsewhere', () => {
    expect(holeAt(holes, [20 + 3.2, 25, 24])).toBe(holes[0]);
    expect(holeAt(holes, [70, 25 - 4.5, 30])).toBe(holes[1]);
    expect(holeAt(holes, [45, 25, 30])).toBeNull();
    // Below the hole's bottom: not the hole.
    expect(holeAt(holes, [20 + 3.2, 25, 10])).toBeNull();
  });

  it('measures between two features that face the same way', () => {
    expect(between(top, bottom)!.mm).toBe(30);
    expect(between(left, { kind: 'hole', hole: holes[0] })!.mm).toBe(20);
    expect(between({ kind: 'hole', hole: holes[0] }, { kind: 'hole', hole: holes[1] })!.mm).toBeCloseTo(50, 9);
    expect(between(top, left)).toBeNull();
    // Two points: straight across.
    expect(between({ kind: 'point', p: [0, 0, 0] }, { kind: 'point', p: [3, 4, 0] })!.mm).toBe(5);
  });

  it('draws the dimension off the part, parallel to what it measures', () => {
    const m = between(top, bottom)!;
    const d = placeDimension(m.from, m.to, m.dir, box, 10);
    expect(d.a[2]).toBeCloseTo(30, 9);
    expect(d.b[2]).toBeCloseTo(0, 9);
    // Outside the box in X or Y.
    const outside = (p: number[]) => p[0] < 0 || p[0] > 100 || p[1] < 0 || p[1] > 50;
    expect(outside(d.a) && outside(d.b) && outside(d.label)).toBe(true);
  });
});
