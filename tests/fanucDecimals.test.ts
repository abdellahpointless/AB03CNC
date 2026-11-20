import { describe, expect, it } from 'vitest';
import { addCoordinateDots, analyzeGCode, codeOnly, detectMaterial, generateRemappedCode, isAluOrBrass } from '../src/lib/gcodeProcessor';
import { convertHaasToFanuc } from '../src/lib/haasToFanucConverter';
import { defaultToolbox } from '../src/lib/defaultTools';
import { engineMachineId } from '../src/regions';

// FANUC reads a coordinate without a decimal point in thousandths of a mm: a lost dot made the
// tool move wrong and broke tools. No program output for a FANUC machine may lose a dot, and every
// whole-number X/Y/Z gets one. Run on the shop's real programs.

const files = import.meta.glob('./corpus/*.txt', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const programs = Object.entries(files).map(([name, code]) => ({ name, code }));

/** Every number written with a dot in the code (comments excluded), with its letter: "Z-22.889", "F230.". */
const dotted = (code: string) => code.split('\n').flatMap((l) => codeOnly(l).match(/(?<![A-Z_#])[A-Z]\s*[-+]?(?:\d+\.\d*|\.\d+)/gi) ?? []).map((w) => w.replace(/\s+/g, '').toUpperCase());
/** Whole-number X/Y/Z left without a dot. */
const bareXYZ = (code: string) => code.split('\n').flatMap((l) => codeOnly(l).match(/(?<![A-Z_#\]])[XYZ]\s*[-+]?\d+(?![\d.])/gi) ?? []);

function count(words: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of words) m.set(w, (m.get(w) ?? 0) + 1);
  return m;
}
/** Each dotted number of the source is still in the output (as often: lines are only added). */
function expectNoDotLost(source: string, output: string, name: string, machine = '') {
  const out = count(dotted(output));
  // Values changed on purpose (still written with their dot): FH pecks over 5 mm become Q5.;
  // on FANUC-2, aluminium/brass pecks become Q2. and spindle speeds over 5000 become S5000.
  const fh = detectMaterial(source) === 'FH';
  const f2 = machine === 'FANUC-2';
  const changed = (w: string) => (w.startsWith('Q') && (fh || (f2 && isAluOrBrass(source)))) || (f2 && w.startsWith('S'));
  for (const [w, n] of count(dotted(source))) if (!changed(w)) expect(out.get(w) ?? 0, `${name}: ${w}`).toBeGreaterThanOrEqual(n);
}

const fanucProfiles = ['FANUC-1', 'FANUC-2', engineMachineId('tr', { id: 'ROBODRILL-1', brand: 'FANUC' })];

describe('FANUC programs keep every decimal point', () => {
  for (const machine of fanucProfiles) {
    it(`remap on ${machine}: no dot lost, every X/Y/Z has one`, () => {
      for (const p of programs) {
        const a = analyzeGCode(p.code, defaultToolbox['FANUC-1']!, machine);
        const out = generateRemappedCode(a.lines, a.blocks, {}, machine).finalCode;
        expectNoDotLost(p.code, out, `${machine} ${p.name}`, machine);
        expect(bareXYZ(out), `${machine} ${p.name}`).toEqual([]);
      }
    });
  }

  it('HAAS -> FANUC conversion: no dot lost, every X/Y/Z has one', () => {
    for (const p of programs) {
      const out = convertHaasToFanuc(p.code, p.name).fanucCode;
      expectNoDotLost(p.code, out, p.name);
      expect(bareXYZ(out), p.name).toEqual([]);
    }
  });

  it('the reported case: F100. and Z-5. keep their dot', () => {
    const src = 'O1\nT6 M6\n(SB_04.00_050_000_ALHS)\nG00 G43 H6 Z50.\nS3500 M03\nG01 Z-5. F100.\nG00 Z50.\nM30';
    const out = convertHaasToFanuc(src).fanucCode;
    expect(out).toMatch(/G01 Z-5\. F100\./);
    expect(out).toMatch(/G00 G43 Z50\. H#513 D#513 M254/);
  });

  it('adds a dot to whole-number X/Y/Z only, never to other words or a value that has one', () => {
    expect(addCoordinateDots(['N10 G01 X10 Y-5 Z0 F300 S8000 Q2 R2 (Z5 IN COMMENT)'])).toEqual(['N10 G01 X10. Y-5. Z0. F300 S8000 Q2 R2 (Z5 IN COMMENT)']);
    expect(addCoordinateDots(['G01 X1.5 Y.5 Z-.25 X#5 Z[#1+2]'])).toEqual(['G01 X1.5 Y.5 Z-.25 X#5 Z[#1+2]']);
    const once = addCoordinateDots(['G00 X10 Y20 Z30']);
    expect(addCoordinateDots(once)).toEqual(once);
  });

  it('HAAS machines are not changed by it (their programs already keep their dots)', () => {
    for (const p of programs.slice(0, 5)) {
      const a = analyzeGCode(p.code, defaultToolbox['HAAS-2']!, 'HAAS-2');
      expectNoDotLost(p.code, generateRemappedCode(a.lines, a.blocks, {}, 'HAAS-2').finalCode, p.name);
    }
  });
});

describe('FANUC-2: spindle at most S5000, 2 mm pecks in aluminium and brass', () => {
  const run = (src: string, machine: string) => {
    const a = analyzeGCode(src, defaultToolbox['FANUC-1']!, machine);
    return generateRemappedCode(a.lines, a.blocks, {}, machine).finalCode;
  };
  const prog = (material: string) =>
    `O1\n(BLOCK ${material} / 18X10X11 / ZUSCHNITT:22X14X20)\nN10 T5 M6\nN11 (SB_04.00_050_000_ALHS)\nN12 G00 G43 H5 Z50.\nN13 S8000 M03\nN14 G98 G83 Z-10. R2. Q2.5 F300.\nN15 X5. Y5.\nN16 S5000 M03\nN17 S4800 M03\nN18 G65 P9000 Q7.\nN19 G98 G73 Z-5. R2. Q1. F200.\nN20 M30`;

  it('caps S above 5000, leaves S5000 and below, keeps F', () => {
    const out = run(prog('ALU'), 'FANUC-2');
    expect(out).toMatch(/N13 S5000 M03/);
    expect(out).toMatch(/N16 S5000 M03/);
    expect(out).toMatch(/N17 S4800 M03/);
    expect(out).toMatch(/F300\./);
    expect(out).not.toMatch(/S8000/);
  });

  it('ALU and MS: G83/G73 pecks become Q2.; macro arguments keep their Q', () => {
    for (const m of ['ALU', 'MS58.ZN40B']) {
      const out = run(prog(m), 'FANUC-2');
      expect(out, m).toMatch(/G83 Z-10\. R2\. Q2\. F300\./);
      expect(out, m).toMatch(/G73 Z-5\. R2\. Q2\. F200\./);
      expect(out, m).toMatch(/G65 P9000 Q7\./);
    }
  });

  it('other materials keep their Q', () => {
    const out = run(prog('POM'), 'FANUC-2');
    expect(out).toMatch(/Q2\.5/);
    expect(out).toMatch(/Q1\./);
  });

  it('no other machine is affected', () => {
    for (const m of ['FANUC-1', 'HAAS-2', 'HAAS-1']) {
      const out = run(prog('ALU'), m);
      expect(out, m).toMatch(/S8000/);
      expect(out, m).toMatch(/Q2\.5/);
    }
  });
});
