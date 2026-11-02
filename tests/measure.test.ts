import { describe, expect, it } from 'vitest';
import { circleOf, distance } from '../src/lib/measure';
import type { Vec } from '../src/lib/toolpath';

describe('measuring', () => {
  it('measures the distance between two points', () => {
    expect(distance([0, 0, 0], [3, 4, 12])).toBe(13);
  });

  it('finds a hole diameter from three points on its wall, at different depths', () => {
    // A Ø6.4 hole along Z at (10, 20): points on the wall at depths 2, 5 and 9, normals pointing inward.
    const r = 3.2;
    const at = (deg: number, z: number): [Vec, Vec] => {
      const a = (deg * Math.PI) / 180;
      return [[10 + r * Math.cos(a), 20 + r * Math.sin(a), -z], [-Math.cos(a), -Math.sin(a), 0]];
    };
    const picks = [at(10, 2), at(130, 5), at(250, 9)];
    const c = circleOf([picks[0][0], picks[1][0], picks[2][0]], [picks[0][1], picks[1][1], picks[2][1]])!;
    expect(c.diameter).toBeCloseTo(6.4, 9);
    expect(c.centre[0]).toBeCloseTo(10, 9);
    expect(c.centre[1]).toBeCloseTo(20, 9);
    expect(Math.abs(c.axis[2])).toBeCloseTo(1, 9);
  });

  it('works for a hole along any axis, and says when the points are in a line', () => {
    // A Ø8 hole along X (drilled into a side face).
    const pts: Vec[] = [[1, 4, 0], [5, 0, 4], [9, -4, 0]];
    const nrm: Vec[] = [[0, -1, 0], [0, 0, -1], [0, 1, 0]];
    expect(circleOf(pts as [Vec, Vec, Vec], nrm as [Vec, Vec, Vec])!.diameter).toBeCloseTo(8, 9);
    expect(circleOf([[0, 0, 0], [1, 0, 0], [2, 0, 0]], [[0, 0, 1], [0, 0, 1], [0, 0, 1]])).toBeNull();
  });
});
