import { describe, expect, it } from 'vitest';
import { compareHoles, moveTime, SIM_DEFAULTS, simulate } from '../src/lib/cam/holeSim';

// The hole simulator the owner asked for (cycles expanded as a Haas does, Setting 22's delta, trapezoidal time).
const prog = (body: string[]) => ['%', 'O1', 'T1 M6', '(3MM BOHRER)', '(DIAMETER 3.00 MM/LENGTH 35.00 MM)', 'G00 G90 X0. Y0. S3000 M03', 'G00 G43 H01 Z50. M08', ...body, 'G00 Z50.', 'M30', '%'].join('\n');

describe('the hole simulator', () => {
  it('expands G83 with full retracts to R and back down to the delta over the last peck, G98 to the start height', () => {
    const r = simulate(prog(['G00 Z5.', 'G98 G83 X10. Y0. Z-10. R2. Q3. F300.', 'G80']));
    const feeds = r.moves.filter((m) => m.kind === 'feed').map((m) => m.to[2]);
    expect(feeds).toEqual([-1, -4, -7, -10]);
    const rapidsZ = r.moves.filter((m) => m.kind === 'rapid').map((m) => m.to[2]);
    // Back to R after a peck, then down to 1.27 over it; out to the start height (Z5) at the end.
    expect(rapidsZ).toContain(2);
    expect(rapidsZ.some((z) => Math.abs(z - (-1 + 1.27)) < 1e-9)).toBe(true);
    expect(rapidsZ[rapidsZ.length - 2]).toBe(5);
    expect(r.holes).toMatchObject([{ c: [10, 0], bottom: -10, start: 2, how: 'G83', d: 3 }]);
  });

  it('expands G73 with the delta retract only, G81 as one feed, G99 back to R; Z R Q carried to the next hole', () => {
    const r = simulate(prog(['G00 Z5.', 'G99 G73 X0. Y0. Z-6. R.5 Q2. F300.', 'X10.', 'G80', 'G98 G81 X20. Y0. Z-2. R.5 F300.', 'G80']));
    const g73 = r.moves.filter((m) => m.line === 8);
    expect(g73.filter((m) => m.kind === 'feed').map((m) => m.to[2])).toEqual([-1.5, -3.5, -5.5, -6]);
    expect(g73.some((m) => m.kind === 'rapid' && m.to[2] === 0.5 && m.from[2] < 0)).toBe(true);
    expect(r.holes.map((h) => [h.c[0], h.how, h.bottom])).toEqual([[0, 'G73', -6], [10, 'G73', -6], [20, 'G81', -2]]);
    // G99: back to R between the holes; G98 after the G81 to its start height.
    expect(r.moves.filter((m) => m.line === 9 && m.kind === 'rapid').pop()!.to[2]).toBe(0.5);
  });

  it('finds a milled hole (a plunge and a helix) with its centre and the diameter it sweeps', () => {
    const r = simulate(prog(['G00 X.3 Y0.', 'G00 Z1.', 'G01 Z0. F100.', 'G03 X.3 Y0. Z-2. I-.3 J0. F200.', 'G03 X.3 Y0. Z-4. I-.3 J0.', 'G03 X.3 Y0. I-.3 J0.', 'G00 Z50.']));
    const h = r.holes.find((x) => x.how === 'milled')!;
    expect(h.c[0]).toBeCloseTo(0, 2);
    expect(h.swept).toBeCloseTo(3.6, 2);
    expect(h.bottom).toBe(-4);
  });

  it('times a move with trapezoidal acceleration (a triangle when too short to reach the speed)', () => {
    const v = 25400 / 60;
    expect(moveTime(1000, 25400)).toBeCloseTo(1000 / v + v / SIM_DEFAULTS.accel + SIM_DEFAULTS.block, 6);
    expect(moveTime(1, 25400)).toBeCloseTo(2 * Math.sqrt(1 / SIM_DEFAULTS.accel) + SIM_DEFAULTS.block, 6);
  });

  it('times an arc as the one move it is to the machine, not as its chords', () => {
    // A full circle of radius 2 at F600: one move of 4π mm.
    const r = simulate(prog(['G00 X2. Y0. Z0.', 'G01 Z-1. F600.', 'G03 X2. Y0. I-2. J0.']));
    const arc = r.moves.filter((m) => m.t !== undefined);
    expect(arc.length).toBeGreaterThan(4);
    expect(arc.reduce((t, m) => t + m.t!, 0)).toBeCloseTo(moveTime(4 * Math.PI, 600), 6);
  });

  it('says loudly when a hole moved, got shallower or starts in the material', () => {
    const a = simulate(prog(['G00 Z5.', 'G98 G83 X10. Y0. Z-10. R2. Q3. F300.', 'G80']));
    expect(compareHoles(a, simulate(prog(['G00 Z5.', 'G98 G83 X10. Y0. Z-10. R.5 Q3. F300.', 'G80'])))).toEqual([]);
    expect(compareHoles(a, simulate(prog(['G00 Z5.', 'G98 G83 X10.01 Y0. Z-10. R.5 Q3. F300.', 'G80'])))[0]).toMatch(/missing/);
    expect(compareHoles(a, simulate(prog(['G00 Z5.', 'G98 G83 X10. Y0. Z-9. R.5 Q3. F300.', 'G80'])))[0]).toMatch(/bottom/);
    expect(compareHoles(a, simulate(prog(['G00 Z5.', 'G98 G83 X10. Y0. Z-10. R0. Q3. F300.', 'G80'])))[0]).toMatch(/under the material/);
  });
});
