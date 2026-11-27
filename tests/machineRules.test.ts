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

  it('a program made for an air machine gets its coolant back on a lubricant machine (M83 -> M08, code only)', () => {
    const air = [header('BASE POM / 30X20X10'), 'N6 T3 M6', 'N7 (M83 AIR)', 'N8 G00 G43 H03 Z50. M83', 'N9 M83', 'N10 M830 M183', 'N11 M30', '%'].join('\n').split('\n');
    for (const id of ['HAAS-1', 'HAAS-5', 'FANUC-1', 'FANUC-2']) {
      const out = applyMachineCoolant(air, id);
      expect(out, id).toContain('N8 G00 G43 H03 Z50. M08');
      expect(out, id).toContain('N9 M08');
      expect(out, id).toContain('N7 (M83 AIR)');
      expect(out, id).toContain('N10 M830 M183');
      expect(applyMachineCoolant(out, id), id).toEqual(out);
    }
    // HAAS-1 and HAAS-5 still switch the air jet off on the safety line.
    expect(applyMachineCoolant(air, 'HAAS-1')).toContain('N4 G40 G17 G53 G49 G80 G90 M84');
    expect(applyMachineCoolant(air, 'HAAS-2')).toEqual(air);
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
    for (const m of CAM_MATERIALS) expect(materialNeed(m), m).toBe(coolantNeed(`(3D-MODELL)\n(PART ${m} / 40X30X12 / ZUSCHNITT:44X34X16)`));
    expect(materialNeed(null)).toBeNull();
  });
});

describe('the air jet line of a program without O line or safety line', () => {
  it('goes after the leading %, never above it', () => {
    const src = ['%', '(BRACKET POM)', 'G00 G90 G17 G40 G80 G49', 'G54', 'T6 M6', 'M30', '%'];
    expect(applyMachineCoolant(src, 'HAAS-1').slice(0, 3)).toEqual(['%', 'M84', '(BRACKET POM)']);
    expect(applyMachineCoolant(['%O1234', ...src.slice(1)], 'HAAS-5').slice(0, 2)).toEqual(['%O1234', 'M84']);
  });
});

describe("HAAS-1's Ø16 mills: T2 roughing, T21 finishing", () => {
  const tools = [
    { id: 'r', number: 2, pocket: 2, category: 'fraise ebauche', description: 'Fraise D16', diameter: 16, length: 48 },
    { id: 'f', number: 21, pocket: 21, category: 'fraise finition', description: 'Fraise D16', diameter: 16, length: 48 },
    { id: 's', number: 7, pocket: 7, category: 'fraise', description: 'Fraise D4 L16', diameter: 4, length: 16 },
  ] as Parameters<typeof analyzeGCode>[1];
  const run = (program: string) => {
    const a = analyzeGCode(program, tools, 'HAAS-1');
    return generateRemappedCode(a.lines, a.blocks, {}, 'HAAS-1').finalCode;
  };
  const block = (t: number, d: number, l: number) => [`N${t}0 T${t} M6`, `N${t}1 (${d}MM FRAESER/${l}MM LANG / SF_${d.toFixed(2).padStart(5, '0')}_${String(l).padStart(3, '0')}_000_ALHS)`, `N${t}2 G00 G43 H${t} Z50.`, `N${t}3 G01 Z-2. F300.`];

  it('gives T2 and T21 to two Ø16 mills in a row', () => {
    const out = run(['%', 'O1000', ...block(2, 16, 48), ...block(3, 16, 48), 'N99 M30', '%'].join('\n'));
    expect(out).toMatch(/T2 M6/);
    expect(out).toMatch(/T21 M6/);
  });

  it('never takes a 16 mm long mill of another Ø for the Ø16 one (a Ø4 x 16 after a Ø16 keeps its tool)', () => {
    const out = run(['%', 'O1000', ...block(2, 16, 48), ...block(7, 4, 16), 'N99 M30', '%'].join('\n'));
    expect(out).toMatch(/T7 M6/);
    expect(out.match(/T21 M6/g) ?? []).toHaveLength(1);
  });
});
