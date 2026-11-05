import { describe, expect, it } from 'vitest';
import { partLook } from '../src/lib/partLook';

const head = (line: string) => `%\nO0001\nN1 (NC_PROGRAM)\nN3 (${line})\nN4 (F.ART.NR.: TC-X20)\n`;
describe('part look', () => {
  it('FH under 10 mm thick has no white top; PC GF has its own look', () => {
    expect(partLook(head('TOP PLATE FH / 100X50X30 / ZUSCHNITT:104X54X40'))).toBe('fh');
    expect(partLook(head('BASE PLATE FH / 100X50X8 / ZUSCHNITT:104X54X10'))).toBe('fhThin');
    expect(partLook(head('COVER PCGF / 60X40X12'))).toBe('pcgf');
    expect(partLook(head('COVER PC GF / 60X40X12'))).toBe('pcgf');
    expect(partLook(head('COVER PC-GF30 / 60X40X12'))).toBe('pcgf');
    expect(partLook(head('BLOCK ALU / 18X10X11 / ZUSCHNITT:22X14X20'))).toBe('alu');
  });
});
