import { describe, expect, it } from 'vitest';
import { analyzeGCode, generateRemappedCode } from '../src/lib/gcodeProcessor';
import { defaultToolbox } from '../src/lib/defaultTools';
import type { Tool } from '../src/types';

// "Delete section" for a tap the machine cannot run: from the tap's tool change (inclusive) up to
// the next tool change, or up to the end-of-program codes, which stay. The program stays valid.

const SKIP: Tool = { id: 'skip', number: 0, category: 'empty', diameter: 0, length: 0, description: 'Skip Operation' };

function deleteTaps(src: string, machine: string) {
  const a = analyzeGCode(src, defaultToolbox[machine.startsWith('HAAS') ? 'HAAS-2' : 'FANUC-1']!, machine);
  const res: Record<string, Tool> = {};
  for (const b of a.blocks) if (/GB_/.test(b.contextStr)) res[b.blockId] = SKIP;
  return generateRemappedCode(a.lines, a.blocks, res, machine).finalCode;
}

const drill = (n: number) => `N${n} T5 M6\nN${n + 1} (BOHRER / SB_05.00_050_000_ALHS)\nN${n + 2} G00 G43 H5 Z50.\nN${n + 3} S3000 M03\nN${n + 4} G98 G83 Z-10. R2. Q2. F300.\nN${n + 5} G80`;
const tap = (n: number) => `N${n} T27 M6\nN${n + 1} (TARAUD M6 / GB_06.00_045_000_ALHS)\nN${n + 2} G00 G43 H27 Z50.\nN${n + 3} G98 G84 Z-8. R2. F500. S500 M03\nN${n + 4} G80\nN${n + 5} M09`;
const mill = (n: number) => `N${n} T8 M6\nN${n + 1} (SF_08.00_050_000_ALHS)\nN${n + 2} G00 G43 H8 Z50.\nN${n + 3} S6000 M03\nN${n + 4} G01 Z-2. F400.`;
const end = 'N90 M09\nN91 M05\nN92 G53 G49 Z0\nN93 M30\n%';

const machines = ['HAAS-2', 'HAAS-1'];

describe('delete the tap section', () => {
  for (const machine of machines) {
    it(`${machine}: a tap in the middle, with its pre-staging call`, () => {
      const out = deleteTaps(`%\nO1\n${drill(10)}\nN17 T27\n${tap(20)}\n${mill(30)}\n${end}`, machine);
      expect(out).not.toMatch(/G84|GB_|T27/);
      expect(out).toMatch(/G83 Z-10\./);
      expect(out).toMatch(/T\d+ M6[^\n]*\n[^\n]*SF_08/);
      expect(out).toMatch(/G01 Z-2\. F400\./);
      expect(out.trim().endsWith('M30\n%')).toBe(true);
    });

    it(`${machine}: a tap as the last tool keeps the end-of-program codes`, () => {
      const out = deleteTaps(`%\nO1\n${drill(10)}\n${tap(20)}\n${end}`, machine);
      expect(out).not.toMatch(/G84|GB_/);
      for (const code of ['M05', 'G53 G49 Z0', 'M30']) expect(out, code).toContain(code);
      expect(out.trim().endsWith('M30\n%')).toBe(true);
      expect(out).toMatch(/G83 Z-10\./);
    });

    it(`${machine}: several taps, one after the other and the last one`, () => {
      const out = deleteTaps(`%\nO1\n${tap(10)}\n${drill(20)}\n${tap(30)}\n${tap(40)}\n${mill(50)}\n${tap(60)}\n${end}`, machine);
      expect(out).not.toMatch(/G84|GB_|T27/);
      expect(out).toMatch(/G83 Z-10\./);
      expect(out).toMatch(/G01 Z-2\. F400\./);
      expect(out.match(/M30/g)).toHaveLength(1);
      expect(out.trim().endsWith('M30\n%')).toBe(true);
    });
  }

  it('a part flip written in the tap section stays (the next tools are set up by it)', () => {
    const src = `%\nO1\n${drill(10)}\nN20 T27 M6\nN21 (TARAUD M6 / GB_06.00_045_000_ALHS)\nN22 M0 (TEIL 180 GRAD UM X DREHEN)\nN23 G52 X-48. Y48. Z16.\nN24 G00 G43 H27 Z50.\nN25 G98 G84 Z-8. R2. F500. S500 M03\nN26 G80\n${mill(30)}\n${end}`;
    const out = deleteTaps(src, 'HAAS-2');
    expect(out).not.toMatch(/G84|GB_/);
    expect(out).toMatch(/M0 \(TEIL 180 GRAD UM X DREHEN\)\n[^\n]*G52 X-48\. Y48\. Z16\./);
    expect(out).toMatch(/G53 Y0[^\n]*\n[^\n]*M0 \(TEIL/);
  });

  it('a flip that already has its G53 Y0 keeps it, without a second one', () => {
    const src = `%\nO1\n${drill(10)}\nN20 T27 M6\nN21 (TARAUD M6 / GB_06.00_045_000_ALHS)\nN22 G53 Y0\nN23 M0 (TEIL 180 GRAD UM X DREHEN)\nN24 G52 X-48. Y48. Z16.\nN25 G00 G43 H27 Z50.\nN26 G98 G84 Z-8. R2. F500. S500 M03\n${mill(30)}\n${end}`;
    const out = deleteTaps(src, 'HAAS-2');
    expect(out).toMatch(/N22 G53 Y0\nN23 M0 \(TEIL[^\n]*\nN24 G52/);
    expect(out.match(/G53 Y0/g)).toHaveLength(2); // the flip and the end of the program
  });

  it('a FANUC tap the operator chose to delete goes the same way', () => {
    const out = deleteTaps(`%\nO1\n${drill(10)}\n${tap(20)}\n${end}`, 'FANUC-1');
    expect(out).not.toMatch(/G84|GB_/);
    expect(out.trim().endsWith('M30\n%')).toBe(true);
  });
});

describe('FANUC M6 taps: T27 only for the standard thread, and only the machine\'s own T27', () => {
  const t27: Tool = { id: 't27', number: 27, category: 'taraud', description: 'Taraud M6', diameter: 6, length: 45 };
  const prog = (comment: string, cycle: string) => `%\nO1\nN10 T240100 M6\nN11 M01 (${comment})\nN12 G00 G43 Z50. H#513 D#513 M254\nN13 M29 S300\nN14 ${cycle}\nN15 G80\nN16 M30\n%`;
  const fine = prog('GEWINDEBOHRER M6X0.75 / GB_06.00_040_075_FH', 'G98 G84 Z-8. R2. F225');
  const coarse = prog('TARAUD M6 / GB_06.00_045_000_ALHS', 'G98 G84 Z-8. R2. F300');
  const tool = (src: string, tools: Tool[]) => analyzeGCode(src, tools, 'FANUC-1').blocks[0].matchedTool?.number ?? null;

  it('takes T27 for an M6x1 tap when the machine has it', () => {
    expect(tool(coarse, [...defaultToolbox['FANUC-1']!, t27])).toBe(27);
    // No feed in the cycle: the tool code's "000" is the standard thread.
    expect(tool(prog('TARAUD M6 / GB_06.00_045_000_ALHS', 'G98 G84 Z-8. R2.'), [t27])).toBe(27);
  });

  it('never takes T27 for a fine thread, never invents it, never takes a T27 that is not that tap', () => {
    expect(tool(fine, [t27])).toBeNull();
    expect(tool(prog('GEWINDEBOHRER M6X0.75 / GB_06.00_040_075_FH', 'G98 G84 Z-8. R2.'), [t27])).toBeNull();
    expect(tool(coarse, defaultToolbox['FANUC-1']!)).toBeNull();
    expect(tool(coarse, [{ ...t27, category: 'fraise' }])).toBeNull();
    expect(analyzeGCode(fine, [t27], 'FANUC-1').success).toBe(false);
  });
});
