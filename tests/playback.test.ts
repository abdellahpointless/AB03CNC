import { describe, expect, it } from 'vitest';
import { DRILL_DOWN, hitInstant } from '../src/lib/playback';
import type { Move } from '../src/lib/toolpath';

const mv = (kind: Move['kind'], points: Move['points'], depth?: number): Move => ({ kind, tool: 1, line: 0, points, depth, seconds: 1, length: 1, setup: 0 });

describe('hitInstant', () => {
  it('finds where the tool passes over the hit point, by X/Y', () => {
    const moves = [mv('feed', [[0, 0, 0], [10, 0, 0], [10, 10, 0]])];
    // A quarter of the way: 5 mm into the 20 mm path; the holder point is above the tip (Z ignored).
    expect(hitInstant(moves, 0, [5, 0, 40])).toBeCloseTo(0.25);
    expect(hitInstant(moves, 0, [10, 5, 0])).toBeCloseTo(0.75);
    // A hit at the end of the move stays in that move.
    expect(Math.floor(hitInstant(moves, 0, [10, 10, 0]))).toBe(0);
  });
  it('puts a drilling hit at the hole bottom', () => {
    const moves = [mv('feed', [[0, 0, 0], [1, 0, 0]]), mv('drill', [[3, 3, 2]], -10)];
    expect(hitInstant(moves, 1, [3, 3, 30])).toBeCloseTo(1 + DRILL_DOWN);
  });
});
