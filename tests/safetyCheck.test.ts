import { describe, expect, it } from 'vitest';
import { checkProgram } from '../src/lib/safetyCheck';

const haasOk = [
  '%', 'O1203 (BRIDE)', 'G40 G17 G53 G49 G80 G90',
  'T4 M6 (POINTEUR)', 'G0 G90 G54 X10. Y20. S3000 M3', 'G43 H4 Z50. M8',
  'G81 Z-2. R2. F100.', 'X30. Y20.', 'G80',
  'G0 G53 G49 Z0.', 'T7 M6', 'G0 G90 G54 X0 Y0 S2500 M3', 'G43 H7 Z50.', 'G1 Z-5. F200.', 'G2 X10. Y10. I5. J0.', 'G0 Z50.',
  'G53 G49 Z0.', 'M30', '%',
].join('\n');

const fanucOk = [
  '%', 'O1203', 'G0 G53 G49 Z0 G94 M95', 'T250550 M6', 'G90 G0 G54 X10. Y20. S3000 M3',
  'G43 H#513 D#513 M254 Z50. M8', 'G81 Z-2. R2. F100', 'G80', 'T240100 M6', 'G0 G54 X0 Y0',
  'G43 H#513 D#513 M254 Z30.', 'M29 S500', 'G84 Z-20. R5. F750', 'G80', 'G0 G53 G49 Z0 G94 M95', 'M30', '%',
].join('\n');

const codes = (r: ReturnType<typeof checkProgram>) => r.findings.map((f) => `${f.level}:${f.code}@${f.params.line}`);

describe('program safety check', () => {
  it('passes clean HAAS and FANUC programs', () => {
    expect(codes(checkProgram(haasOk, { fanuc: false }))).toEqual([]);
    expect(codes(checkProgram(fanucOk, { fanuc: true }))).toEqual([]);
  });

  it('finds a missing length offset, once per tool', () => {
    const p = haasOk.replace('G43 H7 Z50.', 'G0 Z50.');
    expect(codes(checkProgram(p, { fanuc: false }))).toEqual(['error:noOffset@14']);
  });

  it('finds cutting with the spindle stopped', () => {
    const p = haasOk.replace('G0 G90 G54 X0 Y0 S2500 M3', 'G0 G90 G54 X0 Y0');
    expect(codes(checkProgram(p, { fanuc: false }))).toEqual(['error:spindleOff@14']);
  });

  it('finds an H number that is not the tool in the spindle (HAAS)', () => {
    const p = haasOk.replace('G43 H7 Z50.', 'G43 H4 Z50.');
    const r = checkProgram(p, { fanuc: false });
    expect(codes(r)).toEqual(['warning:offsetMismatch@13']);
    expect(r.findings[0].params).toMatchObject({ h: 'H4', t: 'T7' });
  });

  it('finds no feed, no work offset and no program end', () => {
    const p = ['T1 M6', 'G0 X0 Y0 S1000 M3', 'G43 H1 Z5.', 'G1 Z-1.'].join('\n');
    expect(codes(checkProgram(p, { fanuc: false }))).toEqual(['error:noFeed@4', 'warning:noWorkOffset@2', 'warning:noProgramEnd@']);
  });

  it('reports tools too short for the deepest cut', () => {
    const r = checkProgram(haasOk, { fanuc: false, toolDepths: [{ tool: 7, length: 40, depth: 42 }, { tool: 4, length: 60, depth: 2 }] });
    expect(codes(r)).toEqual(['error:toolTooShort@']);
    expect(r.passed).not.toContain('toolTooShort');
  });

  it('ignores comments and the N label', () => {
    const p = haasOk.replace('G43 H7 Z50.', 'N130 (G43 H7 IS IN A COMMENT) G0 Z50.');
    const r = checkProgram(p, { fanuc: false });
    expect(r.findings.map((f) => f.code)).toEqual(['noOffset']);
  });
});
