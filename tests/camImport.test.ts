import { describe, expect, it } from 'vitest';
import { editRun, runsOf } from '../src/lib/cam/importEdit';

// Made-up program: two tools in one clamping, a drill cycle with its R plane.
const PROGRAM = [
  '%',
  'O1000 (TEST)',
  'N1 (TEIL MIT 40 IN X UND 30 IN Y EINSPANNEN)',
  'N2 M0 (38 MM UNTERLAGE)',
  'T3 M6 (SF_08.00_040_000_ALHS)',
  'G0 G90 G54 X0. Y0. S6000 M3',
  'G43 H3 Z50. M8',
  'G1 Z-2. F500.',
  'G1 X20.',
  'G1 Z-5.',
  'G0 Z50.',
  'T7 M6 (SB_05.00_050_000_HSS)',
  'G0 X10. Y10. S3000 M3',
  'G43 H7 Z50.',
  'G81 X10. Y10. Z-12. R2. F200.',
  'G80',
  'G53 Z0.',
  'M30',
  '%',
].join('\n');

describe('a program opened in CAM AI and changed by hand (you, Beta 2: item 3)', () => {
  it('cuts it into runs of one tool each, with the lines each holds', () => {
    const runs = runsOf(PROGRAM);
    expect(runs.map((r) => r.tool)).toEqual([3, 7]);
    expect(runs[0].label).toBe('SF_08.00_040_000_ALHS');
    expect(PROGRAM.split('\n').slice(runs[0].from, runs[0].to + 1)[0]).toBe('T3 M6 (SF_08.00_040_000_ALHS)');
    expect(runs[1].to).toBe(PROGRAM.split('\n').indexOf('G80'));
  });

  it('moves one run only, its tool change, length offset, machine positions and comments as they were', () => {
    const out = editRun(PROGRAM, runsOf(PROGRAM)[0], { dx: 1, dz: -0.5 }).split('\n');
    const was = PROGRAM.split('\n');
    expect(out[was.indexOf('G1 X20.')]).toBe('G1 X21.');
    expect(out[was.indexOf('G1 Z-5.')]).toBe('G1 Z-5.5');
    expect(out[was.indexOf('T3 M6 (SF_08.00_040_000_ALHS)')]).toBe('T3 M6 (SF_08.00_040_000_ALHS)');
    expect(out[was.indexOf('G43 H3 Z50. M8')]).toBe('G43 H3 Z50. M8');
    // The other tool's lines are untouched.
    expect(out.slice(was.indexOf('T7 M6 (SB_05.00_050_000_HSS)'))).toEqual(was.slice(was.indexOf('T7 M6 (SB_05.00_050_000_HSS)')));
  });

  it('takes a drill cycle deeper at its bottom only, its R plane where it was', () => {
    const out = editRun(PROGRAM, runsOf(PROGRAM)[1], { deeper: 2 }).split('\n');
    expect(out[PROGRAM.split('\n').indexOf('G81 X10. Y10. Z-12. R2. F200.')]).toBe('G81 X10. Y10. Z-14. R2. F200.');
  });
});
