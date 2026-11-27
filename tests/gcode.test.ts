import { describe, expect, it } from 'vitest';
import { addG49AfterM6, analyzeGCode, applyG53BeforeG52, codeOnly, generateRemappedCode, isFanucDialect, isHaasDialectForFanuc, isToolChangeLine, isWholeProgram, replaceInCode } from '../src/lib/gcodeProcessor';
import { convertHaasToFanuc } from '../src/lib/haasToFanucConverter';
import { convertFanucToHaas } from '../src/lib/fanucToHaasConverter';
import { defaultToolbox } from '../src/lib/defaultTools';
import { parseToolpath } from '../src/lib/toolpath';
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

  it('reads Windows (CRLF) programs: the remap notes stay on their line, one line ending in the output', () => {
    const src = ['%', 'O1', 'N10 T1 M6', 'N11 (SB_04.00_045_000_ALHS)', 'N12 G00 G43 H1 Z50. M08', 'N13 G81 Z-12. F100.', 'N14 M30', '%'].join('\r\n');
    const { code } = remap(src, haas2, 'HAAS-2');
    expect(code).not.toMatch(/\r/);
    expect(code).toMatch(/^N10 T\d+ M6 \(AUTO-REMAP: T\d+ foret\)$/m);
    expect(code).toMatch(/^N12 G00 G43 H\d+ Z50\. M83 \(AI-MOD: OFFSET H\d+\)$/m);
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
    expect(code).toContain('G43 H#513 D#513 Z50. M08 (DRILL CYCLE) (AI-MOD: FANUC OFFSETS)');
    expect(code).toContain('G01 Z-10.');
  });

  it('no G53 Y0 for the first clamping at the start of the program, only for the flips after it', () => {
    // O0999607's start: the operator loads the raw part (M0 notes, G52) before anything moves.
    const src = ['%', 'O0999607(X20)', 'N7 G0 G53 G49 Z0 G94 M95', 'N9 G54', 'N10 M0 (TEIL MIT 24.5 IN X UND 20 IN Y EINSPANNEN)', 'N11 M0 (40 MM UNTERLAGE)', 'N12 G52 X-48.000 Y48.000 Z16.000', 'N13 (TOOLPATH PLAN_MK40_1)', 'N14 T3 M6', 'N15 M01 (MESSERKOPF D40 / MK_40.00_030_000_ALHS)', 'N17 G00 G43 Z53. H3 M08', 'N18 G00 G90 X52.5 Y-8.125 S8000 M03', 'N19 G01 Z1.5 F3000', 'N20 T5 M6', 'N21 (FRAISE)', 'N22 M0 (TEIL 180 GRAD UM Y DREHEN)', 'N23 G52 X-48.000 Y48.000 Z10.000', 'N24 G01 X5. F300', 'N25 M30', '%'];
    const out = applyG53BeforeG52(src).lines;
    expect(out.slice(0, 7)).toEqual(src.slice(0, 7)); // the start is left as it is
    expect(out.filter((l) => /G53 Y0/.test(l))).toHaveLength(2); // the flip and the end
    expect(out[out.findIndex((l) => l.includes('TEIL 180 GRAD')) - 1]).toMatch(/G53 Y0$/);
  });

  it('inserts G53 Y0 after the tool name comment and before G52, and before M30', () => {
    const src = 'O1\nN9 G0 X0 Y0 Z5.\nN10 T1 M6\nN11 (SB_04.00_045_000_ALHS)\nN12 G52 X10 Y10\nN13 G43 H1 Z50.\nN14 M30';
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
    const spaced = applyG53BeforeG52(['N5 G0 X0', 'N10 T1 M6', 'N20 (TOOL)', 'N30 M0', 'N40 G52 X5', 'N50 G0 X0']).lines;
    expect(spaced).toEqual(['N5 G0 X0', 'N10 T1 M6', 'N20 (TOOL)', 'N21 G53 Y0', 'N30 M0', 'N40 G52 X5', 'N50 G0 X0']);
    const labels = applyG53BeforeG52(['N0 G0 X0', 'N1 T1 M6', 'N2 M0', 'N3 G52 X5', 'N4 M99 P2']).lines;
    expect(labels).toEqual(['N0 G0 X0', 'N1 T1 M6', 'G53 Y0', 'N2 M0', 'N3 G52 X5', 'N4 M99 P2']);
  });

  it('only scans up to the tool change: an earlier tool\'s G53 Y0 does not count', () => {
    const src = ['N1 T1 M6', 'N2 G53 Y0', 'N3 G0 X0 Y0', 'N4 T2 M6', 'N5 (FRAISE)', 'N6 M0', 'N7 G52 X5', 'N8 G52 X-5 Y2'];
    const res = applyG53BeforeG52(src);
    expect(res.addedCount).toBe(1); // one for both G52s of tool 2
    expect(res.lines).toEqual(['N1 T1 M6', 'N2 G53 Y0', 'N3 G0 X0 Y0', 'N4 T2 M6', 'N5 (FRAISE)', 'N6 G53 Y0', 'N7 M0', 'N8 G52 X5', 'N9 G52 X-5 Y2']);
  });

  it('adds G49 right after M6 on FANUC-2 only', () => {
    const src = 'O1\nN15 (TOOLPATH PLAN-MESSERKOPF)\nN16 T3 M6\nN17 (MESSERKOPF D93 / MK_93.00_030_000_FH)\nN18 G43 H3 Z50.\nN19 M30';
    const f2 = remap(src, fanuc1, 'FANUC-2').code;
    expect(f2).toMatch(/^N16 T\d+ M6 G49 \(/m);
    expect(f2.match(/G49/g)?.length).toBe(1);
    expect(f2).toContain('N15 (TOOLPATH PLAN-MESSERKOPF)'); // comments untouched
    expect(remap(src, fanuc1, 'FANUC-1').code).not.toMatch(/G49/);
    expect(remap(src, haas2, 'HAAS-2').code).not.toMatch(/G49/);
  });

  it('FANUC-2 keeps the HAAS code: H of the tool instead of H#513 D#513 M254, M98 P7999 stays', () => {
    const src = 'O1\nN16 T3 M6\nN17 (2MM BOHRER / SB_02.00_030_000_FH)\nN18 G00 G43 H#513 D#513 M254 Z50.\nN19 M98 P7999\nN20 M30';
    const f2 = remap(src, fanuc1, 'FANUC-2').code;
    const t = f2.match(/^N16 T(\d+) M6 G49/m)?.[1];
    expect(t).toBeDefined();
    expect(f2).toMatch(new RegExp(`^N18 G00 G43 H${t} Z50\\.`, 'm'));
    expect(f2).not.toMatch(/H#513|D#513|M254/);
    expect(f2).toContain('M98 P7999');
    // A HAAS program on FANUC-2 gets no FANUC offsets either.
    expect(remap('O1\nN16 T3 M6\nN17 (MESSERKOPF D93 / MK_93.00_030_000_FH)\nN18 G43 H3 Z50.\nN19 M30', fanuc1, 'FANUC-2').code).not.toMatch(/H#513/);
    // FANUC-1 is unchanged.
    expect(remap(src, fanuc1, 'FANUC-1').code).toMatch(/H#513 D#513/);
  });

  it('caps the passes (Q) of FH programs at 5, leaving smaller ones and other materials alone', () => {
    const body = 'N3 T13 M6\nN4 (2.5MM BOHRER/45MM LANG / SB_02.50_045_000_FH)\nN5 G43 H13 Z50.\nN6 G98 G83 Z-9.5 R2. Q8. F300.\nN7 G83 Z-6. R2. Q3.5 F300.\nN8 G83 Z-6. R2. Q12.5 F300. (Q8 IN THE COMMENT)\nN9 M30';
    const fh = remap(`O1 (FH)\n${body}`, haas1, 'HAAS-1').code;
    expect(fh).toMatch(/^N6 G98 G83 Z-9\.5 R2\. Q5\. F300\./m);
    expect(fh).toMatch(/^N7 G83 Z-6\. R2\. Q3\.5 F300\./m);
    expect(fh).toMatch(/^N8 G83 Z-6\. R2\. Q5\. F300\. \(Q8 IN THE COMMENT\)/m);
    expect(remap(`O1 (POM)\n${body}`, haas1, 'HAAS-1').code).toMatch(/Q8\./);
  });

  it('starts a tap\'s spindle with its tapping cycle: the S... M03 on the move before goes', () => {
    const tap = 'N1556 (TOOLPATH GEWINDE_M4_1)\nN1557 T23 M6\nN1558 (GEWINDEBOHRER_M4 / GB_04.00_040_000_FH)\nN1560 G43 H23 Z50.\nN1562 G00 G90 X-8. Y-23.5 S300 M03\nN1563 Z2.\n';
    const code = remap(`O1\n${tap}N1564 G98 G84 Z-7. R2. F280. S300 M03\nN1565 G80\nN1566 M30`, haas1, 'HAAS-1').code;
    expect(code).toMatch(/^N1562 G00 G90 X-8\. Y-23\.5(?! S)/m);
    expect(code).toMatch(/^N1564 G98 G84 Z-7\. R2\. F280\. S300 M03/m);
    // A cycle without its own speed keeps the one on the move (the tap must not turn at the last tool's speed).
    expect(remap(`O1\n${tap}N1564 G98 G84 Z-7. R2. F280.\nN1565 G80\nN1566 M30`, haas1, 'HAAS-1').code).toMatch(/^N1562 G00 G90 X-8\. Y-23\.5 S300 M03/m);
    // Other tools keep theirs.
    expect(remap('O1\nN3 T13 M6\nN4 (2.5MM BOHRER/45MM LANG / SB_02.50_045_000_FH)\nN5 G43 H13 Z50.\nN6 G00 X1. Y1. S5800 M03\nN7 M30', haas1, 'HAAS-1').code).toMatch(/S5800 M03/);
  });

  it('addG49AfterM6 skips comments and lines that already have G49', () => {
    expect(addG49AfterM6(['N16 T3 M6 (APPROX-REMAP: T3 tourteau)', 'N17 (TARAUD M6)', 'N20 T4 M06 G49', 'T5 M6'])).toEqual([
      'N16 T3 M6 G49 (APPROX-REMAP: T3 tourteau)',
      'N17 (TARAUD M6)',
      'N20 T4 M06 G49',
      'T5 M6 G49',
    ]);
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

describe('HAAS -> FANUC switch (audit fixes)', () => {
  const haasEnd = ['O1', 'N1 G40 G17 G53 G49 G80 G90', 'N2 T3 M6', 'N3 (SF_06.00_044_000_ALHS)', 'N4 G00 G43 H03 Z50. M08',
    'N5 G01 Z-1. F100.', 'N6 G00 Z50.', 'N7 G0 G53 G49 Y0 Z0 M89', 'N8 ( Gesamt-Bearbeitungszeit =1MIN )', 'N9 M30'].join('\n');

  it('drops M89, writes one Y0 move before M30, numbers N in steps of 1', () => {
    const lines = convertHaasToFanuc(haasEnd, 'x.txt').fanucCode.split('\n');
    expect(lines.some((l) => /M89/.test(l))).toBe(false);
    expect(lines.filter((l) => /G53/.test(l) && /Y0/.test(l))).toHaveLength(1);
    expect(lines.filter((l) => /M95/.test(l))).toHaveLength(1);
    expect(lines.filter((l) => /^N\d/.test(l)).map((l) => Number(l.match(/^N(\d+)/)![1]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('a bare end retract stays a retract (M95 only at the start)', () => {
    const out = convertHaasToFanuc('O1\nN1 G40 G17 G53 G49 G80 G90\nN2 G53 G49 Z0\nN3 M30', 'x.txt').fanucCode;
    expect(out).toMatch(/N1 G0 G53 G49 Z0\.? G94 M95/);
    expect(out).toMatch(/N2 G0 G53 G49 Z0\.?$/m);
  });

  it('reads code only: a comment never deletes or rewrites its line', () => {
    const out = convertHaasToFanuc('O1\nN1 G0 X0. (NOT M98 P7999)\nN2 (G40 G17 G53 G49 G80 G90)\nN3 M30', 'x.txt').fanucCode;
    expect(out).toMatch(/G0 X0\. \(NOT M98 P7999\)/);
    expect(out).toMatch(/\(G40 G17 G53 G49 G80 G90\)/);
    expect(out).not.toMatch(/M95/);
  });

  it('a G43 line without Z takes the next rapid Z, never an invented one', () => {
    const next = convertHaasToFanuc('O1\nT3 M6\nG00 G43 H03 M08\nG00 Z30.\nM30', 'x.txt').fanucCode;
    expect(next).toMatch(/G00 G43 Z30\. H#513 D#513 M254 M08/);
    const none = convertHaasToFanuc('O1\nT3 M6\nG00 G43 H03\nG01 Z-2. F100.\nM30', 'x.txt').fanucCode;
    expect(none).toMatch(/G00 G43 H#513 D#513 M254$/m);
    const back = convertFanucToHaas('O1\nT3 M6\nG00 G43 H#513 D#513 M254 M08\nM30', 'x.nc').haasCode;
    expect(back).not.toMatch(/Z0\./);
  });

  it('FANUC -> HAAS converts the remapper\'s G43 H#513 lines without M254 too', () => {
    const back = convertFanucToHaas('O1\nT3 M6\nG00 G43 H#513 D#513 Z32.7 M08 (AI-MOD: FANUC OFFSETS)\nM30', 'x.nc').haasCode;
    expect(back).not.toMatch(/#513/);
    expect(back).toMatch(/G00 G43 H03 Z32\.7/);
  });

  it('a HAAS remap turns FANUC offsets into the tool\'s own H', () => {
    const { code } = remap('O1\nN16 T3 M6\nN17 (SB_04.00_045_000_ALHS)\nN18 G00 G43 Z50. H#513 D#513 M254 M08\nN19 M30', haas1, 'HAAS-1');
    expect(code).not.toMatch(/#513|M254/);
  });

  it('G41 D follows the remapped tool on HAAS; FANUC drops M89', () => {
    const src = 'O1\nN10 T7 M6\nN11 (SF_06.00_044_000_ALHS)\nN12 G00 G43 H07 Z50.\nN13 G01 G41 D7 X10. Y10. F500.\nN14 G40 X0.\nN15 G0 G53 G49 Y0 Z0 M89\nN16 M30';
    const h = remap(src, haas1, 'HAAS-1');
    const t = h.code.match(/T(\d+) M6/)![1];
    expect(t).not.toBe('7');
    expect(h.code).toMatch(new RegExp(`G41 D${t} X10`));
    const f = remap(src, fanuc1, 'FANUC-1').code;
    expect(f).not.toMatch(/M89/);
    expect(f.split('\n').filter((l) => /G53/.test(l) && /Y0/.test(l))).toHaveLength(1);
  });

  it('knows which dialect a program is in', () => {
    expect(isHaasDialectForFanuc('N1 G40 G17 G53 G49 G80 G90')).toBe(true);
    expect(isHaasDialectForFanuc('N4 G00 G43 H03 Z50.')).toBe(true);
    expect(isHaasDialectForFanuc('N4 G00 G43 Z50. H#513 D#513 M254 M08\nN1 G0 G53 G49 Z0 G94 M95')).toBe(false);
    expect(isFanucDialect('N4 G00 G43 Z50. H#513 D#513 M254 M08')).toBe(true);
    expect(isFanucDialect('N4 G00 G43 H03 Z50. (H#513 IN A COMMENT)')).toBe(false);
  });
});

describe('dialect converters', () => {
  it('HAAS -> FANUC keeps X/Y/spindle words from the G43 line', () => {
    const src = 'O2345\nG40 G17 G53 G49 G80 G90\nT06 M6\nN100 G00 G43 H06 Z50. X10. Y20. S3500 M03\nN110 M08\nN120 G01 Z-10.\nN130 M30';
    const { fanucCode } = convertHaasToFanuc(src, 'x.txt');
    const lines = fanucCode.split('\n');
    const g43 = lines.findIndex((l) => l.includes('G43'));
    expect(lines[g43]).toMatch(/G00 G43 Z50\. H#513 D#513 M254 M08$/);
    expect(lines[g43 - 1]).toMatch(/G0 X10\. Y20\. S3500 M03$/);
    expect(fanucCode.startsWith('%\n')).toBe(true);
    expect(fanucCode.endsWith('\n%')).toBe(true);
  });

  it('FANUC -> HAAS converts the G43 line with the active tool number', () => {
    const src = '%\nO12345\nN10 (SAMPLE)\nG0 G53 G49 Z0 G94 M95\nN250 M98 P7999\nT06 M06\nG43 H#513 D#513 M254 Z50 M8\nF1200\nM30\n%';
    const { haasCode } = convertFanucToHaas(src, 'x.nc');
    // One line, coolant on it, as the shop's HAAS files write it.
    expect(haasCode).toMatch(/N\d+ G00 G43 H06 Z50\. M08$/m);
    expect(haasCode).not.toContain('M98 P7999');
    expect(haasCode).toContain('F1200.');
  });
});

describe('FANUC -> HAAS fixes', () => {
  const src = [
    '%',
    'O01203 (BRIDE ACIER)',
    'N1 G0 G53 G49 Z0 G94 M95',
    'T250550 M6',
    'G43 H#513 D#513 M254 Z50. M8',
    'M06 T230850',
    'G0 G90 G54 X0 Y0 G43 H#513 D#513 M254 Z30. S8000 M3',
    'G1 Z-5. F200',
    'M30',
    '%',
  ].join('\n');
  const out = convertFanucToHaas(src, 'x.nc').haasCode.split('\n');

  it('reads a tool change written M6 first', () => {
    expect(out.some((l) => /^N\d+ G00 G43 H230850 Z30\.$/.test(l))).toBe(true);
    expect(out.join('\n')).not.toMatch(/H250550 Z30/);
  });
  it('keeps the move and spindle start that shared the G43 line', () => {
    const i = out.findIndex((l) => l.includes('G43 H230850 Z30.'));
    expect(out[i - 1]).toMatch(/^N\d+ G0 G90 G54 X0 Y0 S8000 M3$/);
  });
  it('turns a numbered FANUC safety line into the HAAS one instead of deleting it', () => {
    expect(out[2]).toMatch(/G40 G17 G53 G49 G80 G90$/);
  });
  it('keeps % alone and the program name comment, with the HAAS program number (first digit and last three)', () => {
    expect(out[0]).toBe('%');
    expect(out[out.length - 1]).toBe('%');
    expect(out[1]).toBe('O0203 (BRIDE ACIER)');
  });
  it("keeps the first comment line, as the shop's HAAS files keep N1 (NC_PROGRAM)", () => {
    const r = convertFanucToHaas(['O12345', 'N10 (SAMPLE)', 'T6 M6', 'M30'].join('\n'), 'x.nc').haasCode;
    expect(r).toContain('N1 (SAMPLE)');
  });
});

// The same job as the shop's NX posts write it for each control (shape of the reference library's
// twins, tests/library/twins.test.ts): the converters must turn one into the other.
const SHOP_HAAS = [
  '%', 'O0784', 'N1 (NC_PROGRAM)', 'N2 (DATUM DER ERSTELLUNG: 02.09.25 / BEARBEITER: X)', 'N3 G40 G17 G53 G49 G80 G90', 'N4 G54',
  'N5 M0 (TEIL MIT 60 IN X UND 42 IN Y EINSPANNEN)', 'N6 G52 X-48.000 Y48.000 Z22.000',
  'N7 (TOOLPATH PLAN)', 'N8 T3 M6', 'N9 (MESSERKOPF D40 / MK_40.00_030_000_AL)', 'N10 (DIAMETER 40.00 MM/LENGTH 40.00 MM)', 'N11 M01 (CHECK TOOL)',
  'N12 G00 G43 H03 Z52. M08', 'N13 G00 G90 X86. Y-6. S8000 M03', 'N14 G01 Z1. F3000.', 'N15 G01 X-20.', 'N16 G00 Z50.',
  'N17 (TOOLPATH GEWINDE_M6_075)', 'N18 T500601 M6', 'N19 (GEWINDEBOHRER M6X0.75 / GB_06.00_040_075_ALHS)', 'N20 (DIAMETER  6.00 MM/LENGTH 40.00 MM)',
  'N21 M01 (CHECK TOOL)', 'N22 G00 G43 H500601 Z50. M08', 'N23 G00 G90 X10. Y10. S300 M03', 'N24 G98 G84 Z-15. R2. F225. S300 M03', 'N25 G80',
  'N26 (TOOLPATH ZENTRIER-PC-GF30)', 'N27 T3 M6', 'N28 (MESSERKOPF D40 / MK_40.00_030_000_AL)', 'N29 (DIAMETER 40.00 MM/LENGTH 40.00 MM)', 'N30 G53 Y0',
  'N31 M0 (TEIL 180 GRAD UM X DREHEN/56 IN X UND 38 IN Y)', 'N32 G52 X-50.000 Y50.000 Z-11.000', 'N33 M01 (CHECK TOOL)', 'N34 G00 G43 H03 Z57. M08',
  'N35 G00 G90 X-30. Y-32. S8000 M03', 'N36 G01 Z5.25 F3000.', 'N37 G00 Z50.', 'N38 G0 G53 G49 Y0 Z0 M89', 'N39 ( Gesamt-Bearbeitungszeit =3.7MIN )', 'N40 M30', '%',
].join('\n');
const SHOP_FANUC = [
  '%', 'O0999784(X20)', 'N1 (NC_PROGRAM)', 'N2 (DATUM DER ERSTELLUNG: 02.09.25 / BEARBEITER: X)', 'N3 G0 G53 G49 Z0 G94 M95', 'N4 G54',
  'N5 M0 (TEIL MIT 60 IN X UND 42 IN Y EINSPANNEN)', 'N6 G52 X-48.000 Y48.000 Z22.000',
  'N7 (TOOLPATH PLAN)', 'N8 T3 M6', 'N9 M01 (MESSERKOPF D40 / MK_40.00_030_000_AL)', 'N10 (DIAMETER 40.00 MM/LENGTH 40.00 MM)',
  'N11 G00 G43 Z52. H#513 D#513 M254 M08', 'N12 G00 G90 X86. Y-6. S8000 M03', 'N13 G01 Z1. F3000', 'N14 G01 X-20.', 'N15 G00 Z50.',
  'N16 (TOOLPATH GEWINDE_M6_075)', 'N17 T500601 M6', 'N18 M01 (GEWINDEBOHRER M6X0.75 / GB_06.00_040_075_ALHS)', 'N19 (DIAMETER  6.00 MM/LENGTH 40.00 MM)',
  'N20 G00 G43 Z50. H#513 D#513 M254 M08', 'N21 G00 G90 X10. Y10. S300 M03', 'N22 G98 G84 Z-15. R2. F225 M84 S300 M03', 'N23 G80',
  'N24 (TOOLPATH ZENTRIER-PC-GF30)', 'N25 T3 M6', 'N26 M01 (MESSERKOPF D40 / MK_40.00_030_000_AL)', 'N27 (DIAMETER 40.00 MM/LENGTH 40.00 MM)', 'N28 M98 P7999',
  'N29 M0 (TEIL 180 GRAD UM X DREHEN/56 IN X UND 38 IN Y)', 'N30 G52 X-50.000 Y50.000 Z-11.000', 'N31 G00 G43 Z57. H#513 D#513 M254 M08',
  'N32 G00 G90 X-30. Y-32. S8000 M03', 'N33 G01 Z5.25 F3000', 'N34 G00 Z50.', 'N35 M98 P7999', 'N36 ( Gesamt-Bearbeitungszeit =3.7MIN )', 'N37 M30', '%',
].join('\n');

describe("HAAS <-> FANUC as the shop's posts write them", () => {
  it('HAAS -> FANUC gives the FANUC file, but G53 Y0 where it calls O7999 (not on the machines)', () => {
    const out = convertHaasToFanuc(SHOP_HAAS, 'O0999784.X20').fanucCode.split('\n');
    const want = SHOP_FANUC.split('\n').map((l) => l.replace(/^N28 M98 P7999$/, 'N28 G53 Y0').replace(/^N35 M98 P7999$/, 'N35 G0 G53 G49 Y0 Z0'));
    expect(out).toEqual(want);
  });

  it('FANUC -> HAAS gives the HAAS file', () => {
    expect(convertFanucToHaas(SHOP_FANUC, 'O0999784.X20').haasCode.split('\n')).toEqual(SHOP_HAAS.split('\n'));
  });

  it('the O number: the full one from the file name for FANUC, first digit and last three for HAAS', () => {
    expect(convertHaasToFanuc(SHOP_HAAS, 'O0999784_2.X20').fanucCode.split('\n')[1]).toBe('O0999784(X20)');
    // A file name that is not this program's number: the program's own O number stays.
    expect(convertHaasToFanuc(SHOP_HAAS, 'O0999999.X20').fanucCode.split('\n')[1]).toBe('O0784');
    expect(convertHaasToFanuc(SHOP_HAAS, 'part.nc').fanucCode.split('\n')[1]).toBe('O0784');
    expect(convertFanucToHaas('O01203 (BRIDE ACIER)\nN1 M30', 'x.nc').haasCode.split('\n')[1]).toBe('O0203 (BRIDE ACIER)');
  });

  it('numbers FANUC lines up to N9999, then repeats it as the shop does; HAAS counts on', () => {
    const many = ['%', 'O0784', 'N1 G40 G17 G53 G49 G80 G90', ...Array.from({ length: 10_005 }, (_, k) => `N${k + 2} G01 X${k}.`), 'N10007 G0 G53 G49 Y0 Z0 M89', 'N10008 M30', '%'].join('\n');
    const fan = convertHaasToFanuc(many, 'x.txt').fanucCode.split('\n');
    expect(fan.at(-2)).toBe('N9999 M30');
    expect(fan.filter((l) => l.startsWith('N9999 '))).toHaveLength(10_008 - 9998);
    expect(convertFanucToHaas(fan.join('\n'), 'x.nc').haasCode.split('\n').at(-2)).toBe('N10008 M30');
  });

  it('a FANUC remap brings the table out with G53 Y0 where the program calls O7999, same N, nothing added', () => {
    const { code } = remap(SHOP_FANUC.replace(/O0999784\(X20\)/, 'O0999784'), fanuc1, 'FANUC-1');
    const out = code.split('\n');
    expect(out).toContain('N28 G53 Y0');
    expect(out).toContain('N35 G53 Y0');
    expect(out.filter((l) => /G53 Y0/.test(l))).toHaveLength(2);
    expect(out.at(-2)).toBe('N37 M30');
  });

  it('FANUC-2 keeps M98 P7999 and still brings the table out with G53 Y0 at the flip and at the end', () => {
    const src = SHOP_FANUC.replace(/O0999784\(X20\)/, 'O0999784');
    const out = remap(src, fanuc1, 'FANUC-2').code.split('\n');
    expect(out.filter((l) => /G53 Y0/.test(l))).toEqual(['N26 G53 Y0', 'N38 G53 Y0']);
    expect(out[out.indexOf('N26 G53 Y0') - 1]).toMatch(/^N25 T\d+ M6 G49/); // right after the flip tool's change, before its stops
    expect(out[out.indexOf('N38 G53 Y0') + 1]).toBe('N39 M30');
    expect(out.filter((l) => /M98 P7999/.test(l))).toHaveLength(2);
  });

  it('FANUC-2: skipping the flip tool still brings the table out before the flip', () => {
    const src = SHOP_FANUC.replace(/O0999784\(X20\)/, 'O0999784');
    const a = analyzeGCode(src, fanuc1, 'FANUC-2');
    const skip: Tool = { id: 'skip', number: 0, category: 'empty', diameter: 0, length: 0, description: 'Skip Operation' };
    const out = generateRemappedCode(a.lines, a.blocks, { [a.blocks[2].blockId]: skip }, 'FANUC-2').finalCode.split('\n');
    const flip = out.findIndex((l) => /TEIL 180 GRAD/.test(l));
    const section = out.slice(out.findIndex((l) => /^N24 /.test(l)), flip);
    expect(section.some((l) => /G53 Y0/.test(l))).toBe(true);
    expect(section.some((l) => /M98 P7999/.test(l))).toBe(false);
    // Nothing moves after the last G53 Y0: the table is still out at M30.
    const last = out.map((l) => /G53 Y0/.test(l)).lastIndexOf(true);
    expect(out.slice(last + 1).filter((l) => /(?<![A-Z])[XYZ]-?\d/.test(l.replace(/\(.*?\)/g, '')) && !/G52/.test(l))).toEqual([]);
  });

  it('importing a FANUC program that calls O7999 changes nothing (no second table-out)', () => {
    expect(applyG53BeforeG52(SHOP_FANUC.split('\n')).addedCount).toBe(0);
  });
});

describe('programs from other people cannot freeze the page', () => {
  it('G53 placement stays fast on a program of many G52 lines', () => {
    const lines = ['%', 'O1000', 'G0 X0 Y0', ...Array.from({ length: 100_000 }, () => 'G52 X1'), 'M30', '%'];
    const t = performance.now();
    const r = applyG53BeforeG52(lines);
    expect(performance.now() - t).toBeLessThan(2000);
    expect(r.addedCount).toBe(2); // one before the first G52, one before M30
  });
});

describe('programs that jump to N labels keep them', () => {
  // The code of the line labelled N<n>, without the N: what a jump to n runs.
  const at = (lines: string[], n: number) => lines.find((l) => new RegExp(`^N${n}\\s`).test(l))?.replace(/^N\d+\s*/, '');

  it('FANUC -> HAAS keeps every N, so GOTO lands on the same block', () => {
    const src = 'O1\nT3 M6\nM01 (D10)\nG00 G43 Z50. H#513 D#513 M254\nN10 #1=1.\nN20 G01 Z[-#1] F100\nN30 #1=#1+1.\nN40 IF [#1 LE 3.] GOTO20\nN50 M30';
    const out = convertFanucToHaas(src, 'x.nc').haasCode.split('\n');
    expect(at(out, 20)).toBe('G01 Z[-#1] F100.');
    expect(at(out, 40)).toBe('IF [#1 LE 3.] GOTO20');
  });

  it('HAAS -> FANUC keeps every N too (M99 P and GOTO)', () => {
    const src = '%\nO1234\nN1 G40 G17 G53 G49 G80 G90\nN2 T1 M6\nN3 (FRAISE D10)\nN4 M01 (CHECK TOOL)\nN5 G00 G43 H01 Z50. M08\nN6 #100=0.\nN7 G01 Z[-#100] F2500.\nN8 G01 X-10.\nN9 #100=#100+0.5\nN10 IF [#100 LE 2.] GOTO7\nN11 M99 P7\n%';
    const out = convertHaasToFanuc(src, 'x.nc').fanucCode.split('\n');
    expect(at(out, 7)).toBe('G01 Z[-#100] F2500');
    expect(at(out, 10)).toBe('IF [#100 LE 2.] GOTO7');
  });

  it('a FANUC remap over N9999 keeps the labels a jump needs', () => {
    const body = Array.from({ length: 10_000 }, (_, k) => `N${k + 4} G01 X${k}.`);
    const src = ['O1', 'N1 G0 G53 G49 Z0 G94 M95', 'N2 T3 M6', 'N3 G00 G43 Z50. H#513 D#513 M254', ...body, 'N10004 #1=0', 'N10005 G01 Z-1. F300', 'N10006 #1=#1+1', 'N10007 IF [#1 LT 2] GOTO10005', 'N10008 M30'].join('\n');
    const out = remap(src, fanuc1, 'FANUC-1').code.split('\n');
    expect(at(out, 10005)).toBe('G01 Z-1. F300');
    expect(at(out, 10007)).toBe('IF [#1 LT 2] GOTO10005');
  });
});

describe('a G43 written on the tool change line', () => {
  it('HAAS -> FANUC splits it off and converts it', () => {
    const src = '%\nO1234\nG40 G17 G53 G49 G80 G90\nG54\nT1 M06 G43 H01 Z50.\nG00 X0. Y0. S3000 M03\nG01 Z-5. F300.\nG00 Z50.\nT2 M6\n(BOHRER D5)\nM01 (CHECK TOOL)\nG00 G43 H02 Z50.\nM30\n%';
    const out = convertHaasToFanuc(src, 'x.nc').fanucCode;
    const lines = out.split('\n');
    expect(lines).toContain('N3 T1 M06');
    expect(lines).toContain('N4 G00 G43 Z50. H#513 D#513 M254');
    expect(lines).toContain('N9 M01 (BOHRER D5)'); // the next tool's stop stays on its own comment
    expect(isHaasDialectForFanuc(out)).toBe(false);
  });

  it('FANUC -> HAAS splits it off and converts it', () => {
    const src = '%\nO01234\nG0 G53 G49 Z0 G94 M95\nG54\nT1 M6 G43 Z50. H#513 D#513 M254\nG00 X0. Y0. S3000 M03\nG01 Z-5. F300\nG00 Z50.\nM30\n%';
    const out = convertFanucToHaas(src, 'x.nc').haasCode;
    const lines = out.split('\n');
    expect(lines).toContain('N3 T1 M6');
    expect(lines).toContain('N4 G00 G43 H01 Z50.');
    expect(isFanucDialect(out)).toBe(false);
  });
});

describe('a tool section with two G43 lines', () => {
  it('both take the new tool\'s length offset; an H of another register stays', () => {
    const src = 'O1\nN3 T18 M6\nN4 (FRAISE D10 / FR_10.00_030_000_AL)\nN6 G00 G43 H18 Z50. M08\nN8 G01 Z-2. F500.\nN9 G00 Z50.\nN10 G49\nN11 G00 G43 H18 Z60.\nN12 G01 Z-4. F500.\nN13 G43 H17 Z70. (ANOTHER REGISTER ON PURPOSE)\nN14 M30';
    const a = analyzeGCode(src, haas1, 'HAAS-1');
    const t = haas1.find((x) => x.category === 'fraise' && x.number !== 17 && x.number !== 18)!;
    const out = generateRemappedCode(a.lines, a.blocks, { [a.blocks[0].blockId]: t }, 'HAAS-1').finalCode.split('\n');
    expect(out.find((l) => l.startsWith('N6 '))).toMatch(new RegExp(`G43 H${t.number} `));
    expect(out.find((l) => l.startsWith('N11 '))).toMatch(new RegExp(`G43 H${t.number} `));
    expect(out.find((l) => l.startsWith('N13 '))).toMatch(/G43 H17 /);
  });
});

describe('block delete lines', () => {
  it('keep the slash first, the N number after it, in both directions', () => {
    const haas = '%\nO1234\nN1 G40 G17 G53 G49 G80 G90\nN2 T1 M6\nN3 (FRAISE D10)\nN4 M01 (CHECK TOOL)\nN5 G00 G43 H01 Z50. M08\n/N8 M00 (MEASURE)\n/M00\nN9 M30\n%';
    const fanuc = convertHaasToFanuc(haas, 'x.nc').fanucCode.split('\n');
    const back = convertFanucToHaas(fanuc.join('\n'), 'x.nc').haasCode.split('\n');
    for (const out of [fanuc, back]) {
      expect(out.filter((l) => l.includes('/'))).toEqual([expect.stringMatching(/^\/N\d+ M00 \(MEASURE\)$/), expect.stringMatching(/^\/N\d+ M00$/)]);
    }
  });
});

describe('feed per revolution', () => {
  it('HAAS -> FANUC keeps the dot of every F in a program with G95 (the shop\'s bare F are all G94)', () => {
    const src = '%\nO1234\nN1 G40 G17 G53 G49 G80 G90\nN2 T1 M6\nN3 (GEWINDEBOHRER M6)\nN4 M01 (CHECK TOOL)\nN5 G00 G43 H01 Z50. M08\nN6 G00 X10. Y10. S300 M03\nN7 G95 G98 G84 Z-15. R2. F1. (TAP M6)\nN8 G80 G94\nN9 G01 X20. F300.\nN10 M30\n%';
    const out = convertHaasToFanuc(src, 'x.nc').fanucCode;
    expect(out).toMatch(/G84 Z-15\. R2\. F1\. M84/);
    expect(out).toMatch(/G01 X20\. F300\./);
  });
});

describe('a CHECK TOOL stop after the tool has cut (other posts)', () => {
  it('HAAS -> FANUC leaves it where it is, before the next tool change', () => {
    const src = '%\nO1234\nG40 G17 G53 G49 G80 G90\nT1 M6\n(FRAESER D10)\nG00 G43 H01 Z50. M08\nG01 Z-5. F300.\nG00 Z50.\nM01 (CHECK TOOL)\nT2 M6\n(BOHRER D5)\nG00 G43 H02 Z50. M08\nM30\n%';
    const out = convertHaasToFanuc(src, 'x.nc').fanucCode.split('\n');
    expect(out).toContain('N3 (FRAESER D10)');
    expect(out.slice(out.indexOf('N7 M01 (CHECK TOOL)'), out.indexOf('N7 M01 (CHECK TOOL)') + 2)).toEqual(['N7 M01 (CHECK TOOL)', 'N8 T2 M6']);
  });
});

describe('an O number on the % line', () => {
  it('is still the program number, in both directions', () => {
    const f = '%O01234\nG0 G53 G49 Z0 G94 M95\nT1 M6\nG00 G43 Z50. H#513 D#513 M254\nM30\n%';
    expect(convertFanucToHaas(f, 'x.nc').haasCode.split('\n').slice(0, 3)).toEqual(['%', 'O0234', 'N1 G40 G17 G53 G49 G80 G90']);
    const h = '%O1234\nG40 G17 G53 G49 G80 G90\nT1 M6\nG00 G43 H01 Z50.\nM30\n%';
    expect(convertHaasToFanuc(h, 'x.nc').fanucCode.split('\n').slice(0, 3)).toEqual(['%', 'O1234', 'N1 G0 G53 G49 Z0 G94 M95']);
  });
});

describe('the O line of a FANUC program', () => {
  it('drops the file extension written right after the number, keeps a name written after a space', () => {
    const first = (o: string) => convertFanucToHaas(`${o}\nN1 M30`, 'x.nc').haasCode.split('\n')[1];
    expect(first('O0999784(X20)')).toBe('O0784');
    expect(first('O01234 (ROD)')).toBe('O0234 (ROD)');
    expect(first('O01234 (V2)')).toBe('O0234 (V2)');
    expect(first('O01203 (BRIDE ACIER)')).toBe('O0203 (BRIDE ACIER)');
  });
});

describe('a G43 on a feed move (G01 G43)', () => {
  const kindAfter = (code: string, text: string) => {
    const lines = code.split('\n');
    const tp = parseToolpath(code, { rapid: 30000, toolChange: 5 });
    return tp.moves.find((m) => lines[m.line].includes(text))?.kind;
  };

  it('HAAS -> FANUC keeps the block whole: only the offset words change, the moves after it stay feeds', () => {
    const src = '%\nO1234\nG40 G17 G53 G49 G80 G90\nT3 M6\n(FRAISE D10)\nM01 (CHECK TOOL)\nG00 G90 X10. Y0. S3000 M03\nG01 G43 H03 Z5. F500.\nX20.\nM30\n%';
    const out = convertHaasToFanuc(src, 'x.nc').fanucCode;
    expect(out.split('\n')).toContain('N5 G01 G43 H#513 D#513 M254 Z5. F500');
    expect(out).not.toMatch(/G00 G43/);
    expect(kindAfter(out, 'X20.')).toBe('feed');
  });

  it('FANUC -> HAAS keeps the block whole too', () => {
    const src = '%\nO01234\nG0 G53 G49 Z0 G94 M95\nT3 M6\nM01 (FRAISE D10)\nG00 G90 X10. Y0. S3000 M03\nG01 G43 Z5. H#513 D#513 M254 F500\nX20.\nM30\n%';
    const out = convertFanucToHaas(src, 'x.nc').haasCode;
    expect(out).toMatch(/^N\d+ G01 G43 Z5\. H03 F500\.$/m);
    expect(out).not.toMatch(/G00 G43/);
    expect(kindAfter(out, 'X20.')).toBe('feed');
  });
});

describe('a pasted text', () => {
  it('is a whole program when it has its own O line (then the imported file name no longer fits it)', () => {
    expect(isWholeProgram('%\nO1033\nN1 (PART)\nN2 G40 G17 G53 G49 G80 G90')).toBe(true);
    expect(isWholeProgram('%O01234\nG0 G53 G49 Z0 G94 M95')).toBe(true);
    expect(isWholeProgram('O0999784(X20)\nN1 (NC_PROGRAM)')).toBe(true);
    expect(isWholeProgram('N7 G01 X20. F300.\nN8 G00 Z50.')).toBe(false);
    expect(isWholeProgram('N9 M98 P7999\nN10 (O1234 IN A COMMENT)')).toBe(false);
  });
});
