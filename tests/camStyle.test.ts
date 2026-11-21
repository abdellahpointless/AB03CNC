import { describe, expect, it } from 'vitest';
import { arcs, shopStyle, shorten } from '../src/lib/cam/style';
import { parseToolpath, speedsFor } from '../src/lib/toolpath';

// A program as CAM AI's post writes it: every word on every line, each hole its own cycle line.
const cam = [
  '%',
  'O0001',
  'N1 (CAM AI)',
  'N2 (TEIL ALU / 40X30X10 / ZUSCHNITT:44X34X15)',
  'N3 G40 G17 G53 G49 G80 G90',
  'N4 G54',
  'N5 M0 (TEIL MIT 44 IN X UND 34 IN Y EINSPANNEN/Z+ IN 2.5MM)',
  'N6 M0 (40 MM UNTERLAGE)',
  'N7 G52 X-28. Y33. Z-3.',
  'N8 M09',
  'N9 (TOOLPATH FRAESEN_8MM)',
  'N10 T2 M6',
  'N11 (SF_08.00_040_000_ALHS)',
  'N12 (DIAMETER 8.00 MM/LENGTH 40.00 MM)',
  'N13 M01 (CHECK TOOL)',
  'N14 G00 G43 H02 Z50. M08',
  'N15 G00 G90 X-10. Y-5. S12000 M03',
  'N16 G00 Z4.5',
  'N17 G00 Z4.5',
  'N18 G00 X-10. Y-5.',
  'N19 G01 Z0.5 F400.',
  'N20 G01 X10. Y-5. F1200.',
  'N21 G01 X10. Y5. F1200.',
  'N22 G01 X-10. Y5. F1200.',
  'N23 G01 X-10. Y-5. Z-0.5 F1200.',
  'N24 G00 Z4.5',
  'N25 G00 Z50.',
  'N26 M09',
  'N27 (TOOLPATH ZENTRIERBOHREN)',
  'N28 T3 M6',
  'N29 (ZB_02.30_040_000_ALHS)',
  'N30 (DIAMETER 2.30 MM/LENGTH 40.00 MM)',
  'N31 M01 (CHECK TOOL)',
  'N32 G00 G43 H03 Z50. M08',
  'N33 G00 G90 X-15. Y-10. S6000 M03',
  'N34 G00 Z2.',
  'N35 G98 G81 X-15. Y-10. Z-0.92 R2. F300.',
  'N36 X15. Y-10. Z-0.92 R2.',
  'N37 X15. Y10. Z-0.92 R2.',
  'N38 G80',
  'N39 G00 Z50.',
  'N40 M09',
  'N41 (TOOLPATH BOHREN_3.3MM)',
  'N42 T4 M6',
  'N43 (SB_03.30_050_000_ALHS)',
  'N44 (DIAMETER 3.30 MM/LENGTH 50.00 MM)',
  'N45 M01 (CHECK TOOL)',
  'N46 G00 G43 H04 Z50. M08',
  'N47 G00 G90 X-15. Y-10. S9000 M03',
  'N48 G00 Z2.',
  'N49 G98 G83 X-15. Y-10. Z-8. R2. Q3. F400.',
  'N50 G98 G83 X15. Y-10. Z-8. R2. Q3. F400.',
  'N51 G98 G83 X15. Y10. Z-12. R2. Q3. F400.',
  'N52 G80',
  'N53 G00 Z50.',
  'N54 M09',
  'N55 G53 Y0',
  'N56 M30',
  '%',
].join('\n');

describe("CAM AI's program in the shop's words", () => {
  const r = shopStyle(cam, 'HAAS');
  const lines = r.code.split('\n');

  it('keeps the very same moves (the app reads them back alike)', () => {
    expect(r.shortened).toBe(true);
  });

  it('leaves out the axes that do not change and the same feed', () => {
    const from = lines.indexOf('N16 G00 Z4.5');
    expect(lines.slice(from, from + 10)).toEqual(['N16 G00 Z4.5', 'N17 G00 Z4.5', 'N18 G00 X-10. Y-5.', 'N19 G01 Z.5 F400.', 'N20 G01 X10. F1200.', 'N21 G01 Y5.', 'N22 G01 X-10.', 'N23 G01 Y-5. Z-.5', 'N24 G00 Z4.5', 'N25 G00 Z50.']);
  });

  it('leaves out a move to where the tool already is only with improvement O1 (not approved yet)', () => {
    const o1 = shopStyle(cam, 'HAAS', (code) => shorten(code, true));
    expect(o1.shortened).toBe(true);
    const at = o1.code.split('\n');
    const from = at.indexOf('N16 G00 Z4.5');
    expect(at.slice(from, from + 3)).toEqual(['N16 G00 Z4.5', 'N17 G01 Z.5 F400.', 'N18 G01 X10. F1200.']);
  });

  it('drills the shop way: one cycle per depth, the further holes with their new X or Y only', () => {
    const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
    const spot = at(/G98 G81/);
    expect(lines.slice(spot, spot + 4).map((l) => l.replace(/^N\d+ /, ''))).toEqual(['G98 G81 Z-.92 R2. F300.', 'X15.', 'Y10.', 'G80']);
    const drill = at(/G98 G83/);
    expect(lines.slice(drill, drill + 6).map((l) => l.replace(/^N\d+ /, ''))).toEqual(['G98 G83 Z-8. R2. Q3. F400.', 'X15.', 'G80', 'G00 Y10.', 'G98 G83 Z-12. R2. Q3. F400.', 'G80']);
  });

  it('numbers the lines again from N1, one after the other', () => {
    const n = lines.filter((l) => /^N\d+ /.test(l)).map((l) => Number(l.match(/^N(\d+)/)![1]));
    expect(n).toEqual(n.map((_, i) => i + 1));
    expect(lines[0]).toBe('%');
    expect(lines.at(-1)).toBe('%');
  });

  it('keeps what follows a machine move as written (where the tool is is not known then)', () => {
    const after = shorten(['N1 G00 G53 Z0', 'N2 G00 Z50.', 'N3 G00 Z50.'].join('\n'), true).split('\n');
    expect(after).toEqual(['N1 G00 G53 Z0', 'N2 G00 Z50.']);
  });

  it('gives the program back as it was when the shortened one would move differently', () => {
    const wrong = (code: string) => code.replace('N21 G01 X10. Y5. F1200.', 'N21 G01 X10. Y6. F1200.');
    const back = shopStyle(cam, 'HAAS', wrong);
    expect(back).toEqual({ code: cam, shortened: false });
  });
});

describe('circles written as arcs', () => {
  // A quarter circle (r 5 about 0,0, counter-clockwise) cut into pieces as CAM AI's offsets do
  // (0.002 mm from the arc), then a straight line on.
  const pieces = (r: number, n: number) => Array.from({ length: n }, (_, k) => [r * Math.cos(((k + 1) * Math.PI) / 2 / n), r * Math.sin(((k + 1) * Math.PI) / 2 / n)]);
  const fmt = (v: number) => String(Math.round(v * 1000) / 1000);
  const program = (pts: number[][]) =>
    ['N1 G00 G90 X5. Y0 S9000 M03', 'N2 G00 Z2.', 'N3 G01 Z-1. F300.', ...pts.map(([x, y], k) => `N${k + 4} G01 X${fmt(x)} Y${fmt(y)}${k === 0 ? ' F900.' : ''}`), `N${pts.length + 4} G01 X-6.`].join('\n');

  it('writes the run as one G03 with I and J from its start, then goes on straight', () => {
    const out = arcs(program(pieces(5, 28))).split('\n');
    expect(out).toEqual(['N1 G00 G90 X5. Y0 S9000 M03', 'N2 G00 Z2.', 'N3 G01 Z-1. F300.', 'N4 G03 X0. Y5. I-5. J0. F900.', 'N5 G01 X-6.']);
  });

  it('stays within a hundredth of a millimetre of the pieces it replaces', () => {
    const before = program(pieces(5, 28));
    const [a, b] = [parseToolpath(before, speedsFor('HAAS')), parseToolpath(arcs(before), speedsFor('HAAS'))];
    const old = a.moves.filter((m) => m.kind === 'feed').flatMap((m) => m.points.slice(1).map((q, k) => [m.points[k], q]));
    const off = (p: number[]) => Math.min(...old.map(([s, e]) => {
      const v = e.map((x, c) => x - s[c]);
      const t = Math.max(0, Math.min(1, v.reduce((acc, x, c) => acc + x * (p[c] - s[c]), 0) / (v.reduce((acc, x) => acc + x * x, 0) || 1)));
      return Math.hypot(...s.map((x, c) => x + t * v[c] - p[c]));
    }));
    for (const m of b.moves.filter((x) => x.kind === 'feed')) for (const p of m.points) expect(off(p)).toBeLessThan(0.012);
  });

  it('leaves pieces as they are where they are not a circle, or too coarse for one', () => {
    const line = ['N1 G00 G90 X0 Y0 S9000 M03', 'N2 G01 Z-1. F300.', 'N3 G01 X1. F900.', 'N4 G01 X2.', 'N5 G01 X3.', 'N6 G01 X4.'].join('\n');
    expect(arcs(line)).toBe(line);
    // Four pieces for a quarter of r 5: 0.1 mm from the arc, more than CAM AI's offsets ever leave.
    const coarse = program(pieces(5, 4));
    expect(arcs(coarse)).toBe(coarse);
  });
});

