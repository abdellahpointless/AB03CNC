import { describe, expect, it } from 'vitest';
import { analyzeGCode, applyMachineCoolant, coolantNeed, generateRemappedCode } from '../src/lib/gcodeProcessor';
import { defaultToolbox } from '../src/lib/defaultTools';
import { coolingOf, isLockedMachine, materialNeed } from '../src/regions';
import { CAM_MATERIALS } from '../src/lib/cam/tools';

// Shop rules from the answers to the Phase 0 questions (reference library work).

const header = (part: string) => ['%', 'O0784', 'N1 (NC_PROGRAM)', `N3 (${part})`, 'N4 G40 G17 G53 G49 G80 G90', 'N5 G54'].join('\n');

describe('machine rules', () => {
  it('DMG machines are locked: not programmed in the app for now', () => {
    expect(isLockedMachine({ brand: 'DMG MORI' })).toBe(true);
    expect(isLockedMachine({ brand: 'HAAS' })).toBe(false);
    expect(isLockedMachine({ brand: 'FANUC' })).toBe(false);
  });

  it('HAAS-2 and HAAS-4 blow air; HAAS-1, HAAS-5, FANUC-1, FANUC-2 and DMG-1 run lubricant', () => {
    expect(['HAAS-2', 'HAAS-4'].map(coolingOf)).toEqual(['air', 'air']);
    expect(['HAAS-1', 'HAAS-5', 'FANUC-1', 'FANUC-2', 'DMG-1'].map(coolingOf)).toEqual(Array(5).fill('lubricant'));
    // Any other machine (another country, a new one): not known, no rule.
    expect(coolingOf('HAAS~tr~HAAS-2')).toBeNull();
  });

  it('reads what the material needs from the part line: FH dry, ALU / PC GF / brass / stainless lubricant', () => {
    expect(coolantNeed(header('TOP PLATE FH / 100X100X40'))).toBe('air');
    for (const part of ['BASE ALU /300X145X9/ZUSCHNITT: 304X150X20', 'CONTOUR INSERT PCGF / 21.2X25.1X17', 'TEST BRACKET PC-GF30 / 50.5X27.5X18.6', 'TEST PIN INSERT PC GF30 / 64X65.5X11.5', 'ANGLE BRACKET MS58 / 17.8X10X13.5', 'CONTOUR BLOCK VA1.4305 / 34X32X15'])
      expect(coolantNeed(header(part)), part).toBe('lubricant');
    // POM and PEEK run either way; other plastics and boards: no rule.
    for (const part of ['CONTACT PIN PLATE POM / 24.5X18X14', 'TEST PIN INSERT PEEK/ 15X13X30', 'CONTACT PIN PLATE EPO. / 37X47X15', 'BEFESTIGUNG PETP / 32X10X8'])
      expect(coolantNeed(header(part)), part).toBeNull();
    // A tool code ending in _FH or _ALHS is not the part's material.
    expect(coolantNeed(header('SUB PLATE POM / 32X10X8') + '\nN6 (8MM FRAESER / SF_08.00_044_000_FH)\nN7 (SB_04.00_050_000_ALHS)')).toBeNull();
  });

  it('writes the air jet code each machine always uses', () => {
    const program = [header('BASE ALU / 30X20X10'), 'N6 T3 M6', 'N7 G00 G43 H03 Z50. M08', 'N8 G01 X10. F300.', 'N9 M30', '%'].join('\n').split('\n');
    // Air machines: the air jet on wherever the program turns the coolant on.
    expect(applyMachineCoolant(program, 'HAAS-2')).toContain('N7 G00 G43 H03 Z50. M83');
    // HAAS lubricant machines: the air jet off (M84) on the safety line, the coolant kept.
    const h1 = applyMachineCoolant(program, 'HAAS-5');
    expect(h1).toContain('N4 G40 G17 G53 G49 G80 G90 M84');
    expect(h1).toContain('N7 G00 G43 H03 Z50. M08');
    // FANUC: nothing added (the FANUC files use M84 only on tapping lines; to be confirmed).
    expect(applyMachineCoolant(program, 'FANUC-1')).toEqual(program);
    // Running it again changes nothing.
    expect(applyMachineCoolant(h1, 'HAAS-5')).toEqual(h1);
  });

  it('the remapper writes them', () => {
    const src = [header('BASE ALU / 30X20X10'), 'N6 T6 M6', 'N7 (SB_04.00_045_000_ALHS)', 'N8 G00 G43 H06 Z50. M08', 'N9 G01 Z-5. F300.', 'N10 M30', '%'].join('\n');
    const out = (machine: string) => {
      const a = analyzeGCode(src, defaultToolbox['HAAS-1']!, machine);
      return generateRemappedCode(a.lines, a.blocks, {}, machine).finalCode;
    };
    expect(out('HAAS-1')).toMatch(/G40 G17 G53 G49 G80 G90 M84/);
    expect(out('HAAS-4')).toMatch(/G43 H\d+ Z50\. M83/);
    expect(out('HAAS-4')).not.toMatch(/M84/);
  });
});

describe('CAM AI and Process ask the same of a material', () => {
  it('the need CAM AI checks is the one Process reads from the part line CAM AI writes', () => {
    for (const m of CAM_MATERIALS) expect(materialNeed(m), m).toBe(coolantNeed(`(CAM AI)\n(PART ${m} / 40X30X12 / ZUSCHNITT:44X34X16)`));
    expect(materialNeed(null)).toBeNull();
  });
});
