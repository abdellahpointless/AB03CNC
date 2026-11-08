import { describe, expect, it } from 'vitest';
import { camProgram, opSegments, type LiveEvent } from '../src/lib/cam/program';
import { cutData, LIBRARY, type CamTool } from '../src/lib/cam/tools';
import { heightPart } from './heightPart';

// A 40x30x12 plate with a 20x12 pocket 6 deep in its top.
const plate = heightPart(Array.from({ length: 30 }, (_, j) => Array.from({ length: 40 }, (_, i) => (i >= 10 && i < 30 && j >= 9 && j < 21 ? 6 : 12))));

describe('the feed moves of an operation', () => {
  it('G01 moves as segments, rapids left out, each drilled hole from R down', () => {
    expect(opSegments(['G00 G90 X0. Y0.', 'G00 Z2.', 'G01 Z-1. F300.', 'G01 X10.', 'G00 Z5.'])).toEqual([0, 0, 2, 0, 0, -1, 0, 0, -1, 10, 0, -1]);
    expect(opSegments(['G98 G81 X5. Y6. Z-3. R1. F200.', 'X7. Y8. Z-3. R1.', 'G80'])).toEqual([5, 6, 1, 5, 6, -3, 7, 8, 1, 7, 8, -3]);
  });
});

describe("the operator's cutting values", () => {
  const mill = LIBRARY.ALU.find((t) => t.type === 'SF' && t.d === 8 && t.length === 40)!;
  const tool = (edit?: CamTool['edit']): CamTool => ({ id: mill.code, number: 1, category: 'fraise', description: '', diameter: mill.d, length: mill.length, code: mill.code, type: mill.type, template: mill, inMachine: true, edit });
  const limits = { maxRpm: 8000, maxFeed: 10000 };

  it('taken as typed, the spindle never over the machine top', () => {
    const c = cutData(tool({ s: 20000, f: 900, ae: 2, ap: 1 }), 'contour', 'ALU', limits);
    expect(c).toMatchObject({ s: 8000, f: 900, ae: 2, ap: 1, unsafe: false });
  });

  it('a depth the tool cannot take is marked unsafe (Download and Send stay locked)', () => {
    expect(cutData(tool({ ap: 8, ae: 8, f: 9000 }), 'contour', 'ALU', limits).unsafe).toBe(true);
    // Deeper than the tool is long: never.
    expect(cutData(tool({ ap: 45 }), 'contour', 'ALU', limits).unsafe).toBe(true);
  });
});

describe('the operator picks the sides and sees it being made', () => {
  it('setup 2 on the side picked, coolant as chosen, every step reported', () => {
    const events: LiveEvent[] = [];
    const code = LIBRARY.ALU.find((t) => t.type === 'MK')?.code ?? '';
    const r = camProgram({
      tris: plate,
      material: 'ALU',
      tools: [],
      brand: 'HAAS',
      raw: [44, 34, 19],
      orient: { side: 'Z+', spin: false },
      second: 'Y+',
      cuts: code ? { [code]: { coolant: 'air' } } : {},
      noNest: true,
      live: (e) => events.push(e),
    });
    expect(r.setups.map((s) => s.side).slice(0, 2)).toEqual(['Z+', 'Y+']);
    const stages = events.filter((e) => e.kind === 'stage').map((e) => (e as { stage: string }).stage);
    expect(stages.slice(0, 3)).toEqual(['features', 'stock', 'setup']);
    expect(stages).toContain('check');
    expect(stages.at(-1)).toBe('post');
    expect(events.some((e) => e.kind === 'path' && e.pts.length >= 6)).toBe(true);
    if (code && r.code.includes(code)) expect(r.code).toMatch(/Z50\. M83/);
  }, 900_000);
});
