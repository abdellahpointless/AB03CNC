import { describe, expect, it } from 'vitest';
import { analyzeGCode, applyG53BeforeG52, codeOnly, generateRemappedCode, isToolChangeLine, replaceInCode } from '../src/lib/gcodeProcessor';
import { convertHaasToFanuc } from '../src/lib/haasToFanucConverter';
import { convertFanucToHaas } from '../src/lib/fanucToHaasConverter';
import { defaultToolbox } from '../src/lib/defaultTools';
import type { Tool } from '../src/types';

const haas1 = defaultToolbox['HAAS-1']!;
const haas2 = defaultToolbox['HAAS-2']!;
const fanuc1 = defaultToolbox['FANUC-1']!;

function remap(src: string, tools: Tool[], machine: string) {
  const a = analyzeGCode(src, tools, machine);
  return { analysis: a, code: generateRemappedCode(a.lines, a.blocks, {}, machine).finalCode };
}

describe('tool change detection', () => {
  it('detects M6 / M06 in code but not inside comments', () => {
    expect(isToolChangeLine('N10 T5 M6')).toBe(true);
    expect(isToolChangeLine('N10 T5 M06 (DRILL)')).toBe(true);
    expect(isToolChangeLine('T5M6')).toBe(true);
    expect(isToolChangeLine('N12 (TARAUD M6)')).toBe(false);
    expect(isToolChangeLine('(T5 M6)')).toBe(false);
    expect(isToolChangeLine('N20 M60')).toBe(false);
    expect(isToolChangeLine('N20 M63')).toBe(false);
  });

  it('does not create a duplicate block for a comment that mentions M6', () => {
    const src = 'O1\nN10 T5 M6\nN11 (GB_06.00_045_000_ALHS)\nN12 (TARAUD M6)\nN13 G43 H5 Z50.\nN20 T6 M6\nN21 (SB_05.00_055_000_ALHS)\nN22 M30';
    const { blocks } = analyzeGCode(src, haas2, 'HAAS-2');
    expect(blocks.map((b) => b.blockId)).toEqual(['block-1', 'block-5']);
  });
});

describe('analysis', () => {
  it('reads Z depths written without a leading zero', () => {
    const src = 'O1\nN10 T2 M6\nN11 (SF_06.00_044_000_ALHS)\nN12 G43 H2 Z50.\nN13 G1 Z-.5\nN14 M30';
    const { blocks } = analyzeGCode(src, haas2, 'HAAS-2');
    expect(blocks[0].minZDepth).toBe(-0.5);
  });

  it('flags a crash risk when the deepest Z is longer than the tool', () => {
    const src = 'O1\nN10 T2 M6\nN11 (SF_06.00_044_000_ALHS)\nN12 G43 H2 Z50.\nN13 G1 Z-60.\nN14 M30';
    const { blocks } = analyzeGCode(src, haas2, 'HAAS-2');
    expect(blocks[0].zDepthError).toBe(true);
  });

  it('ignores D/L words in the code when guessing the tool size', () => {
    const src = 'O1\nN10 T4 M6\nN11 (FRAISE)\nN12 G41 D1 X0 Y0\nN13 G43 H4 Z50.\nN14 M30';
    const { blocks } = analyzeGCode(src, haas1, 'HAAS-1');
    expect(blocks[0].parsedDiameter).toBeNull();
    expect(blocks[0].matchedTool).toBeNull();
  });

  it('parses the structured designator in the tool comment', () => {
    const src = 'O1\nN14 T2 M6\nN15 (SB_04.00_045_000_ALHS)\nN16 G43 H2 Z50.\nN17 G81 Z-12. F100.\nN18 M30';
    const { blocks } = analyzeGCode(src, haas2, 'HAAS-2');
    expect(blocks[0]).toMatchObject({ parsedCategory: 'foret', parsedDiameter: 4, parsedLength: 45 });
    expect(blocks[0].matchedTool?.category).toBe('foret');
    expect(blocks[0].matchedTool?.diameter).toBe(4);
  });
});

describe('code generation', () => {
  it('remaps the T on the M6 line, not a pre-staged T on the line before', () => {
    const src = 'O1\nN10 T1 M6\nN11 (SB_04.00_045_000_ALHS)\nN12 G43 H1 Z50.\nN14 T7 (PRESTAGE)\nN15 T3 M6\nN16 (SF_06.00_044_000_ALHS)\nN17 G43 H3 Z50.\nN18 M30';
    const { code } = remap(src, haas2, 'HAAS-2');
    expect(code).toContain('N14 T7 (PRESTAGE)\n');
    expect(code).toMatch(/N15 T27 M6 \(AUTO-REMAP: T27 fraise\)/);
    expect(code).toContain('N17 G43 H27 Z50. (AI-MOD: OFFSET H27)');
    // No G53 Y0 at ordinary tool changes, only one before the end of the program
    expect(code.split('\n').filter((l) => /G53 Y0/.test(l))).toEqual(['N18 G53 Y0']);
    expect(code).toContain('N18 G53 Y0\nN19 M30');
  });

  it('adds FANUC offsets without damaging comments', () => {
    const src = '%\nO1\nT06 M6 (SB_04.00_050_000_VAHS)\nG43 H06 Z50 M08 (DRILL CYCLE)\nG01 Z-10\nM30\n%';
    const { code } = remap(src, fanuc1, 'FANUC-1');
    expect(code).toContain('G43 H#513 D#513 Z50 M08 (DRILL CYCLE) (AI-MOD: FANUC OFFSETS)');
  });

  it('inserts G53 Y0 after the tool name comment and before G52, and before M30', () => {
    const src = 'O1\nN10 T1 M6\nN11 (SB_04.00_045_000_ALHS)\nN12 G52 X10 Y10\nN13 G43 H1 Z50.\nN14 M30';
    const { code } = remap(src, haas2, 'HAAS-2');
    const lines = code.split('\n');
    const g52 = lines.findIndex((l) => l.includes('G52'));
    expect(lines[g52 - 1]).toMatch(/G53 Y0/);
    expect(lines.filter((l) => /G53 Y0/.test(l)).length).toBe(2);
    expect(lines[lines.length - 2]).toMatch(/G53 Y0$/);
    expect(lines[lines.length - 1]).toMatch(/M30$/);
  });

  // The program from the shop-floor screenshot (tool 13, part turned 180 degrees), as it should be.
  const SHOT = [
    'N6179 G00 Z50.',
    'N6180 (TOOLPATH PLAN-MK-93-SCHR)',
    'N6181 T13 M6',
    'N6182 (MESSERKOPF D93 / MK_93.00_030_000_KS)',
    'N6183 (DIAMETER 93.00 MM/LENGTH 30.00 MM)',
    'N6184 G53 Y0',
    'N6185 M0 (TEIL 180 GRAD UM X DREHEN/)',
    'N6186 M0 (36 MM UNTERLAGE/IN 10.5 MM)',
    'N6187 G52 X-50.000 Y50.000 Z-10.500',
    'N6188 M01 (CHECK TOOL)',
    'N6189 G00 G43 H13 Z58. M08',
    'N6190 G01 Z-5. F500',
    'N6191 G00 Z50.',
    'N6192 G53 Y0',
    'N6193 M30',
  ];
  // Same program as the CAM writes it without any G53 Y0 (numbers consecutive, no gap).
  const SHOT_MISSING = SHOT.filter((l) => !/G53 Y0/.test(l)).map((l, i) => l.replace(/^N\d+/, `N${6179 + i}`));

  it('does not add a G53 Y0 when it already exists above the G52 and before M30', () => {
    const res = applyG53BeforeG52(SHOT);
    expect(res.addedCount).toBe(0);
    expect(res.lines).toEqual(SHOT);
    const { code } = remap(SHOT.join('\n'), haas2, 'HAAS-2');
    expect(code.split('\n').filter((l) => /G53 Y0/.test(l))).toEqual(['N6184 G53 Y0', 'N6192 G53 Y0']);
  });

  it('adds missing G53 Y0 before the M0 stops of the flip and before M30, with their own N numbers', () => {
    const res = applyG53BeforeG52(SHOT_MISSING);
    expect(res.addedCount).toBe(2);
    expect(res.lines).toEqual(SHOT); // identical to the correct program, numbering included
    const { code } = remap(SHOT_MISSING.join('\n'), haas2, 'HAAS-2');
    const lines = code.split('\n');
    expect(lines.filter((l) => /G53 Y0/.test(l))).toEqual(['N6184 G53 Y0', 'N6192 G53 Y0']);
    expect(lines[lines.indexOf('N6184 G53 Y0') + 1]).toMatch(/^N6185 M0 \(TEIL 180/);
    const ns = lines.map((l) => l.match(/^N(\d+)/)?.[1]).filter(Boolean);
    expect(new Set(ns).size).toBe(ns.length); // no duplicate N numbers
  });

  it('never adds G53 Y0 at tool changes without a G52, and ignores a G52 that only cancels the shift', () => {
    const src = ['N1 T1 M6', 'N2 (FORET)', 'N3 G0 X0 Y0', 'N4 T2 M6', 'N5 (FRAISE)', 'N6 G0 X5 Y5', 'N7 G52 X0 Y0 Z0', 'N8 G0 Z50.', 'N9 M30'];
    const res = applyG53BeforeG52(src);
    expect(res.addedCount).toBe(1);
    expect(res.lines).toEqual(['N1 T1 M6', 'N2 (FORET)', 'N3 G0 X0 Y0', 'N4 T2 M6', 'N5 (FRAISE)', 'N6 G0 X5 Y5', 'N7 G52 X0 Y0 Z0', 'N8 G0 Z50.', 'N9 G53 Y0', 'N10 M30']);
  });

  it('keeps N numbers when there is a free number, and does not renumber programs that jump to labels', () => {
    const spaced = applyG53BeforeG52(['N10 T1 M6', 'N20 (TOOL)', 'N30 M0', 'N40 G52 X5', 'N50 G0 X0']).lines;
    expect(spaced).toEqual(['N10 T1 M6', 'N20 (TOOL)', 'N21 G53 Y0', 'N30 M0', 'N40 G52 X5', 'N50 G0 X0']);
    const labels = applyG53BeforeG52(['N1 T1 M6', 'N2 M0', 'N3 G52 X5', 'N4 M99 P2']).lines;
    expect(labels).toEqual(['N1 T1 M6', 'G53 Y0', 'N2 M0', 'N3 G52 X5', 'N4 M99 P2']);
  });

  it('only scans up to the tool change: an earlier tool\'s G53 Y0 does not count', () => {
    const src = ['N1 T1 M6', 'N2 G53 Y0', 'N3 G0 X0 Y0', 'N4 T2 M6', 'N5 (FRAISE)', 'N6 M0', 'N7 G52 X5', 'N8 G52 X-5 Y2'];
    const res = applyG53BeforeG52(src);
    expect(res.addedCount).toBe(1); // one for both G52s of tool 2
    expect(res.lines).toEqual(['N1 T1 M6', 'N2 G53 Y0', 'N3 G0 X0 Y0', 'N4 T2 M6', 'N5 (FRAISE)', 'N6 G53 Y0', 'N7 M0', 'N8 G52 X5', 'N9 G52 X-5 Y2']);
  });

  it('applyG53BeforeG52 is idempotent', () => {
    const once = applyG53BeforeG52(['N10 G0 X0', 'N20 G52 X5']).lines;
    const twice = applyG53BeforeG52(once);
    expect(twice.addedCount).toBe(0);
    expect(twice.lines).toEqual(once);
  });
});

describe('helpers', () => {
  it('codeOnly strips comments', () => {
    expect(codeOnly('N10 T5 M6 (DRILL T9)').trim()).toBe('N10 T5 M6');
  });
  it('replaceInCode leaves comments untouched', () => {
    expect(replaceInCode('N10 (T9) T5 M6', /T\d+/, 'T1')).toBe('N10 (T9) T1 M6');
  });
});

describe('dialect converters', () => {
  it('HAAS -> FANUC keeps X/Y/spindle words from the G43 line', () => {
    const src = 'O2345\nG40 G17 G53 G49 G80 G90\nT06 M6\nN100 G00 G43 H06 Z50. X10. Y20. S3500 M03\nN110 M08\nN120 G01 Z-10.\nN130 M30';
    const { fanucCode } = convertHaasToFanuc(src, 'x.txt');
    const lines = fanucCode.split('\n');
    const g43 = lines.findIndex((l) => l.includes('G43'));
    expect(lines[g43]).toMatch(/G43 H#513 D#513 M254 Z50 M08$/);
    expect(lines[g43 - 1]).toMatch(/G0 X10\. Y20\. S3500 M03$/);
    expect(fanucCode.startsWith('%\n')).toBe(true);
    expect(fanucCode.endsWith('\n%')).toBe(true);
  });

  it('FANUC -> HAAS converts the G43 line with the active tool number', () => {
    const src = '%\nO12345\nN10 (SAMPLE)\nG0 G53 G49 Z0 G94 M95\nN250 M98 P7999\nT06 M06\nG43 H#513 D#513 M254 Z50 M8\nF1200\nM30\n%';
    const { haasCode } = convertFanucToHaas(src, 'x.nc');
    expect(haasCode).toContain('G00 G43 H06 Z50.');
    expect(haasCode).toMatch(/N\d+ M08/);
    expect(haasCode).not.toContain('M98 P7999');
    expect(haasCode).toContain('F1200.');
  });
});
