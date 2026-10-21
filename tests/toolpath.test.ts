import { describe, expect, it } from 'vitest';
import { parseToolpath, speedsFor } from '../src/lib/toolpath';

const S = { rapid: 30_000, toolChange: 2 };

describe('toolpath reader', () => {
  it('draws straight moves and times them', () => {
    const p = parseToolpath(['T1 M6 (FRAISE D10)', 'G0 G90 G54 X0 Y0 Z10. S3000 M3', 'G1 Z0 F600', 'G1 X60. F600', 'M30'].join('\n'), S);
    expect(p.tools).toEqual([expect.objectContaining({ tool: 1, label: 'FRAISE D10' })]);
    const feeds = p.moves.filter((m) => m.kind === 'feed');
    expect(feeds.map((m) => m.length)).toEqual([10, 60]);
    // 70 mm at 600 mm/min = 7 s, plus one tool change of 2 s
    expect(p.totalSeconds).toBeCloseTo(9, 5);
    expect(p.min).toEqual([0, 0, 0]);
    expect(p.max).toEqual([60, 0, 10]);
  });

  it('follows incremental moves', () => {
    const p = parseToolpath(['G0 G90 X10. Y10. Z5.', 'G91 G1 X5. Y-5. F100', 'G90'].join('\n'), S);
    expect(p.moves[0].points[1]).toEqual([15, 5, 5]);
  });

  it('draws arcs from I/J and from R, in the right direction', () => {
    // Quarter circle radius 10 from (10,0) to (0,10) around the origin, counter-clockwise.
    const ij = parseToolpath(['G0 X10. Y0 Z0', 'G3 X0 Y10. I-10. J0 F100'].join('\n'), S);
    const arc = ij.moves.find((m) => m.kind === 'feed')!;
    expect(arc.length).toBeCloseTo((Math.PI * 10) / 2, 3);
    for (const [x, y] of arc.points) expect(Math.hypot(x, y)).toBeCloseTo(10, 5);
    const mid = arc.points[Math.floor(arc.points.length / 2)];
    expect(mid[0]).toBeGreaterThan(0);
    expect(mid[1]).toBeGreaterThan(0);
    const r = parseToolpath(['G0 X10. Y0 Z0', 'G3 X0 Y10. R10. F100'].join('\n'), S).moves.find((m) => m.kind === 'feed')!;
    expect(r.length).toBeCloseTo((Math.PI * 10) / 2, 3);
    const cw = parseToolpath(['G0 X10. Y0 Z0', 'G2 X0 Y10. R10. F100'].join('\n'), S).moves.find((m) => m.kind === 'feed')!;
    // Clockwise with the same end points and R>0 is also the short way round, centre on the other side.
    expect(cw.length).toBeCloseTo((Math.PI * 10) / 2, 3);
    const m2 = cw.points[Math.floor(cw.points.length / 2)];
    expect(Math.hypot(m2[0] - 10, m2[1] - 10)).toBeCloseTo(10, 5);
  });

  it('reads drilling cycles as holes', () => {
    const p = parseToolpath(['T7 M6', 'G0 G90 G54 X0 Y0 Z50. S2000 M3', 'G43 H7 Z50.', 'G99 G83 X10. Y10. Z-20. R2. Q5. F100', 'X30.', 'X50.', 'G80', 'M30'].join('\n'), S);
    const holes = p.moves.filter((m) => m.kind === 'drill');
    expect(holes.map((h) => h.points[0].slice(0, 2))).toEqual([[10, 10], [30, 10], [50, 10]]);
    expect(holes.every((h) => h.depth === -20)).toBe(true);
    expect(p.lowestZ).toBe(-20);
    expect(p.tools[0].seconds).toBeGreaterThan(3 * ((22 / 100) * 60));
  });

  it('ignores machine-coordinate moves and comments', () => {
    const p = parseToolpath(['G0 G90 X0 Y0 Z5.', '(G1 X100. F50)', 'G53 G49 Z0.', 'G1 X10. F100'].join('\n'), S);
    expect(p.moves.map((m) => m.points[1]?.[0])).toEqual([10]);
  });

  it('uses brand speeds', () => {
    expect(speedsFor('FANUC').rapid).toBeGreaterThan(speedsFor('HAAS').rapid);
  });
});
