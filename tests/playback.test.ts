import { describe, expect, it } from 'vitest';
import { clockAt, DRILL_DOWN, hitInstant } from '../src/lib/playback';
import { parseToolpath, type Move } from '../src/lib/toolpath';

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

describe('clockAt', () => {
  it('counts tool changes, dwells and machine moves where they happen, and ends at the program time', () => {
    const lines = ['T1 M6', 'G0 G90 X0 Y0 Z10.', 'G1 X60. F600', 'G4 P2000', 'G1 X0', 'T2 M6', 'G0 X0 Y0 Z10.', 'G81 X10. Y0 Z-5. R2. F600', 'G80', 'G1 X30. F600', 'G53 G0 Z0.', 'M30'];
    const p = parseToolpath(lines.join('\n'), { rapid: 30_000, toolChange: 2 });
    // Tool change 2 s, 60 mm at 600 mm/min 6 s, dwell 2 s, 6 s back, tool change 2 s, a drilling cycle, 20 mm, G53 up.
    expect(clockAt(p, 0)).toBe(0);
    expect(clockAt(p, 0.5)).toBeCloseTo(2 + 3);
    expect(clockAt(p, 1)).toBeCloseTo(10);
    expect(clockAt(p, 2)).toBeCloseTo(18);
    expect(clockAt(p, p.moves.length)).toBeCloseTo(p.totalSeconds);
    // Never back in time (the cycle's two moves included); the last move ends before the G53 retract after it.
    const at = Array.from({ length: p.moves.length * 4 + 1 }, (_, i) => clockAt(p, i / 4));
    expect(at.every((s, i) => i === 0 || s >= at[i - 1] - 1e-9)).toBe(true);
    expect(clockAt(p, p.moves.length - 1e-6)).toBeLessThan(p.totalSeconds - 0.05);
  });
});
