import { describe, expect, it } from 'vitest';
import plate from './models/O1042013.C60.txt?raw';
import { readProgram, summarise } from '../src/lib/cam/learn';
import knowledge from '../src/lib/cam/shopKnowledge.json';

describe('learning from a program (O1042013, FH top plate)', () => {
  const p = readProgram(plate, 'O1042013');
  it('reads the part, its setups and each operation with its cutting data', () => {
    expect(p.material).toBe('FH');
    expect(p.size).toEqual([100, 50, 40]);
    expect(p.setups).toBe(6);
    const profile = p.samples.find((x) => x.op === 'PROFIL_20MM')!;
    expect(profile).toMatchObject({ type: 'SF', d: 20, length: 55, kind: 'contour', s: 2200, f: 650, fz: 585 });
    expect(profile.ap).toBeCloseTo(3.8, 1);
    const face = p.samples.find((x) => x.type === 'MK')!;
    expect(face).toMatchObject({ kind: 'face', d: 93, s: 4500 });
  });
  it('summarises programs into cutting data and an order of operations', () => {
    const k = summarise([p]);
    expect(k.cut.FH.SF.some((r) => r.d === 20 && r.kind === 'contour' && r.s === 2200)).toBe(true);
    expect(k.order[0]).toBe('face');
  });
  it('ships what was learned from the uploaded programs', () => {
    expect(knowledge.programs).toBeGreaterThanOrEqual(30);
    expect(Object.keys(knowledge.cut).sort()).toEqual(expect.arrayContaining(['ALU', 'FH', 'POM']));
  });
});

// The shop's other ways of writing an operation: a tool code with a copy number ("..._ALHS_1"), an
// operation that goes on with the same tool ("(SCHLICHT_8MM MIT WERKZEUG ...)"), and the spot drill
// named NC-ANBOHREN.
describe('learning from the other ways an operation is written', () => {
  const prog = [
    '%',
    'O0001 (TEST ALU / 50X50X20 / ZUSCHNITT:55X55X25)',
    'N1 G40 G17 G53 G49 G80 G90',
    'N2 (TOOLPATH PLAN_MK40)',
    'N3 T1 M6',
    'N4 (40MM MESSERKOPF / MK_40.00_050_000_ALHS)',
    'N5 (DIAMETER 40.00 MM/LENGTH 50.00 MM)',
    'N6 G00 G43 H1 Z50. M08',
    'N7 G00 G90 X-30. Y10. S5000 M03',
    'N8 G01 Z0. F500.',
    'N9 G01 X80. F3000.',
    'N10 G00 Z50.',
    'N11 (TOOLPATH NC-ANBOHREN)',
    'N12 T2 M6',
    'N13 (SPOT / ZB_06.00_050_000_ALHS)',
    'N14 (DIAMETER 6.00 MM/LENGTH 50.00 MM)',
    'N15 G00 G43 H2 Z50. M08',
    'N16 G00 G90 X10. Y-10. S6000 M03',
    'N17 G98 G81 X10. Y-10. Z-1. R2. F300.',
    'N18 G80',
    'N19 (TOOLPATH BOHREN_1.0MM)',
    'N20 T3 M6',
    'N21 (1MM BOHRER/30MM LANG / SB_01.00_030_000_ALHS_1)',
    'N22 (DIAMETER 1.00 MM/LENGTH 30.00 MM)',
    'N23 G00 G43 H3 Z50. M08',
    'N24 G00 G90 X10. Y-10. S20000 M03',
    'N25 G98 G83 X10. Y-10. Z-5. R2. Q0.3 F200.',
    'N26 G80',
    'N27 (TOOLPATH TASCHE_8MM)',
    'N28 T4 M6',
    'N29 (8MM FRAESER / SF_08.00_040_000_ALHS)',
    'N30 (DIAMETER 8.00 MM/LENGTH 40.00 MM)',
    'N31 G00 G43 H4 Z50. M08',
    'N32 G00 G90 X20. Y-20. S9000 M03',
    'N33 G01 Z-2. F300.',
    'N34 G01 X30. F1500.',
    'N35 G00 Z50.',
    'N36 (SCHLICHT_8MM MIT WERKZEUG SF_08.00_040_000_ALHS)',
    'N37 G00 X20. Y-20.',
    'N38 G01 Z-2. F300.',
    'N39 G01 X31. F1200.',
    'N40 G00 Z50.',
    'N41 M30',
    '%',
  ].join('\n');
  const p = readProgram(prog, 'O0001');

  it('a tool code with a copy number is the tool of its operation', () => {
    expect(p.samples.find((x) => x.op === 'BOHREN_1.0MM')).toMatchObject({ type: 'SB', d: 1, length: 30, material: 'ALU', kind: 'drill', q: 0.3 });
  });
  it('an operation written MIT WERKZEUG is an operation of its own', () => {
    expect(p.samples.find((x) => x.op === 'TASCHE_8MM')).toMatchObject({ kind: 'pocket', f: 1500 });
    expect(p.samples.find((x) => x.op === 'SCHLICHT_8MM')).toMatchObject({ type: 'SF', d: 8, kind: 'finish', f: 1200 });
  });
  it('NC-ANBOHREN is spot drilling', () => {
    expect(p.samples.find((x) => x.op === 'NC-ANBOHREN')).toMatchObject({ type: 'ZB', kind: 'centre' });
    expect(p.order).toEqual([['face', 'centre', 'drill', 'pocket', 'finish']]);
  });
});
