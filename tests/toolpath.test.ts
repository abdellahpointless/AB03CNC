import { describe, expect, it } from 'vitest';
import { ARC_TOLERANCE, parseToolpath, speedsFor } from '../src/lib/toolpath';

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

describe('cutter compensation', () => {
  it('moves the tool off the programmed edge by its radius (G41 left, ramping on and off)', () => {
    const p = parseToolpath(
      ['T1 M6', '(DIAMETER 10.00 MM/LENGTH 30.00 MM)', 'G0 G90 X-20. Y-20. Z5.', 'G1 Z-2. F100', 'G1 G41 D1 X-10. Y-10.', 'G1 X10.', 'Y10.', 'X-10.', 'Y-10.', 'G1 G40 X-20. Y-20.'].join('\n'),
      S,
    );
    const feeds = p.moves.filter((m) => m.kind === 'feed').slice(1);
    // Starts on the path, then runs 5 mm to the left of the square (inside it), corners mitred.
    expect(feeds[0].points[0]).toEqual([-20, -20, -2]);
    expect(feeds.slice(1, 5).map((m) => m.points[1])).toEqual([[5, -5, -2], [5, 5, -2], [-5, 5, -2], [-5, -10, -2]]);
    expect(feeds[5].points[1]).toEqual([-20, -20, -2]);
  });

  it('gives pointed tools their tip', async () => {
    const { tipSlope } = await import('../src/lib/stockSim');
    expect(tipSlope('90 GRAD STICHEL / ST_04.00_025_G45_FH')).toBeCloseTo(1, 5);
    expect(tipSlope('ZENTRIERBOHRER D2MM-1/38MM LANG / ZB_02.30_038_000_FH')).toBeCloseTo(1, 5);
    expect(tipSlope('4.2MM BOHRER/55MM LANG')).toBeCloseTo(Math.tan((59 * Math.PI) / 180), 5);
    expect(tipSlope('GEWINDEBOHRER_M4 / GB_04.00_040_000_FH')).toBeNull();
    expect(tipSlope('8MM FRAESER/44MM LANG')).toBeNull();
  });
});

describe('arcs and codes the shop machines read differently', () => {
  const S = { rapid: 30_000, toolChange: 2 };
  const arcOf = (code: string) => parseToolpath(code, S).moves.filter((m) => m.kind === 'feed').pop()!;

  it('keeps every drawn point of an arc on the circle, within the arc tolerance between points', () => {
    const arc = arcOf('T1 M6\nG0 G90 X50 Y0 Z0\nG3 X-50 Y0 I-50 J0 F500');
    for (const p of arc.points) expect(Math.hypot(p[0], p[1])).toBeCloseTo(50, 9);
    // The middle of each piece is no further than the tolerance inside the circle.
    for (let k = 1; k < arc.points.length; k++) {
      const a = arc.points[k - 1], b = arc.points[k];
      expect(50 - Math.hypot((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)).toBeLessThanOrEqual(ARC_TOLERANCE + 1e-9);
    }
  });

  it('reads R arcs like I/J arcs, including R- for more than half a circle', () => {
    const ij = arcOf('T1 M6\nG0 G90 X10 Y0 Z0\nG2 X0 Y-10 I-10 J0 F500');
    const r = arcOf('T1 M6\nG0 G90 X10 Y0 Z0\nG2 X0 Y-10 R10 F500');
    expect(r.points[Math.floor(r.points.length / 2)][0]).toBeCloseTo(ij.points[Math.floor(ij.points.length / 2)][0], 6);
    // Three quarters of a circle the long way round: passes through X-10.
    const long = arcOf('T1 M6\nG0 G90 X10 Y0 Z0\nG2 X0 Y10 R-10 F500');
    expect(Math.min(...long.points.map((p) => p[0]))).toBeCloseTo(-10, 3);
  });

  it('draws G18 arcs in the XZ plane and G19 arcs in the YZ plane', () => {
    const xz = arcOf('T1 M6\nG0 G90 X10 Y5 Z0\nG18 G3 X-10 Z0 I-10 K0 F500');
    for (const p of xz.points) {
      expect(p[1]).toBeCloseTo(5, 9);
      expect(Math.hypot(p[0], p[2])).toBeCloseTo(10, 9);
    }
    const yz = arcOf('T1 M6\nG0 G90 X3 Y10 Z0\nG19 G2 Y-10 Z0 J-10 K0 F500');
    for (const p of yz.points) expect(Math.hypot(p[1], p[2])).toBeCloseTo(10, 9);
    expect(yz.points.every((p) => p[0] === 3)).toBe(true);
  });

  it('lists what it does not simulate: subprograms, macros, other work offsets, rotation, Haas pocket cycles', () => {
    const tp = parseToolpath(['T1 M6', 'G55 G0 X0 Y0 Z0', 'M98 P1000', '#100=5', 'G68 X0 Y0 R45', 'G12 I5 D1 Z-2', 'M98 P1001'].join('\n'), S);
    expect(tp.unsupported.map((u) => u.kind).sort()).toEqual(['cycle', 'macro', 'offset', 'subprogram', 'transform']);
    expect(tp.unsupported.find((u) => u.kind === 'subprogram')).toEqual({ kind: 'subprogram', line: 2, count: 2 });
    expect(parseToolpath('T1 M6\nG54 G0 X0 Y0 Z0\nG1 X5', S).unsupported).toEqual([]);
  });
});
