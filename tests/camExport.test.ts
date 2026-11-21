import { describe, expect, it } from 'vitest';
import { forMachine } from '../src/lib/cam/export';
import { camProgram } from '../src/lib/cam/program';
import { analyzeGCode, applyG53BeforeG52, generateRemappedCode, isHaasDialectForFanuc } from '../src/lib/gcodeProcessor';
import { convertHaasToFanuc } from '../src/lib/haasToFanucConverter';
import { parseToolpath, speedsFor, type Move } from '../src/lib/toolpath';
import type { Tool } from '../src/types';
import { pocketWithHole } from './heightPart';

/** What Send gives the machine: the program into the remapper, Process (its own tools), Export (ToolRemapper.tsx). */
function send(code: string, machine: string): string {
  let src = code;
  // A Robodrill takes the FANUC dialect: the operator converts first (Process refuses HAAS code there).
  if (machine.startsWith('FANUC') && machine !== 'FANUC-2' && isHaasDialectForFanuc(src)) src = convertHaasToFanuc(src, 'O0001.NC').fanucCode;
  src = applyG53BeforeG52(src.split('\n')).lines.join('\n');
  const a = analyzeGCode(src, [], machine);
  const own: Record<string, Tool> = {};
  for (const b of a.blocks) {
    const n = Number(b.originalT?.match(/\d+/)?.[0] ?? 0);
    own[b.blockId] = { id: `t${n}`, number: n, pocket: n, category: b.parsedCategory ?? 'fraise', diameter: b.parsedDiameter ?? 1, length: b.parsedLength ?? 100, description: '' } as Tool;
  }
  return applyG53BeforeG52(generateRemappedCode(a.lines, a.blocks, own, machine).finalCode.split('\n')).lines.join('\n');
}
/** The code a machine runs: no comments or N numbers, H03 and H3 alike (the same offset). */
const codeOf = (text: string) =>
  text
    .split('\n')
    .map((l) => l.replace(/\([^)]*\)/g, '').replace(/^\s*N\d+\s*/, '').replace(/(?<![A-Z])H0+(\d)/g, 'H$1').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

// What CAM AI's Download (its program's and each nest's) gives each kind of machine: forMachine.
describe("CAM AI's program as each machine gets it", () => {
  // A plate with a pocket (arcs in its corners) and a hole (drilling cycles).
  const part = pocketWithHole(40, 30, 12, [10, 8, 30, 22], 6, { c: [20, 15], d: 4 });
  const r = camProgram({ tris: part, material: 'ALU', tools: [], brand: 'HAAS', raw: [44, 34, 16], noNest: true });
  const moved = (ms: Move[]) => ms.filter((m) => m.kind === 'drill' || m.points.some((p) => p.some((v, c) => Math.abs(v - m.points[0][c]) > 1e-9)));
  const geometry = (code: string, brand: string) => moved(parseToolpath(code, speedsFor(brand)).moves).map((m) => ({ kind: m.kind, setup: m.setup, depth: m.depth, points: m.points.map((p) => p.map((v) => Math.round(v * 1000) / 1000)) }));
  const machines = ['HAAS-1', 'HAAS-2', 'HAAS-3', 'FANUC-1', 'FANUC-2'];

  it('has arcs and drilling cycles, and the shop’s end', () => {
    expect(r.code).toMatch(/ G0[23] X/);
    expect(r.code).toMatch(/ G98 G8[13] /);
    expect(r.code).toMatch(/G0 G53 G49 Y0 Z0 M89\n.*Gesamt-Bearbeitungszeit =\d+\.\dMIN/);
  }, 600_000);

  it('reads back as the same moves on every machine', () => {
    const own = geometry(r.code, 'HAAS');
    for (const machine of machines) {
      const sent = forMachine(r.code, machine, 'O0001.NC');
      const fanuc = machine === 'FANUC-1';
      expect(geometry(sent, fanuc ? 'FANUC' : 'HAAS'), machine).toEqual(own);
      // M89 (HAAS through-spindle coolant off) never reaches a Robodrill.
      if (fanuc) expect(sent).not.toMatch(/M89/);
    }
  });

  it('gives each machine the same code as Send and Process in the remapper, FH pecks included', () => {
    for (const machine of machines) expect(codeOf(forMachine(r.code, machine, 'O0001.NC')), machine).toEqual(codeOf(send(r.code, machine)));
    // The same part labelled FH with 8 mm pecks: at most 5 mm both ways.
    const fh = r.code.replace(/\bALU\b/g, 'FH').replace(/(?<![A-Z])Q[\d.]+/g, 'Q8.');
    for (const machine of ['HAAS-2', 'FANUC-2']) {
      const sent = forMachine(fh, machine, 'O0001.NC');
      expect(codeOf(sent), machine).toEqual(codeOf(send(fh, machine)));
      expect(sent).not.toMatch(/(?<![A-Z])Q8/);
    }
  });

  it('follows the FANUC-2 rules: G49 on each tool change, at most S5000, 2 mm pecks in aluminium', () => {
    const sent = forMachine(r.code, 'FANUC-2', 'O0001.NC').split('\n').map((l) => l.replace(/\([^)]*\)/g, ''));
    const changes = sent.filter((l) => /(?<![A-Z])M0?6(?![0-9])/.test(l));
    expect(changes.length).toBeGreaterThan(1);
    for (const l of changes) expect(l).toMatch(/(?<![A-Z])G49(?![0-9])/);
    expect(Math.max(...sent.flatMap((l) => [...l.matchAll(/(?<![A-Z])S(\d+)/g)].map((m) => Number(m[1]))))).toBeLessThanOrEqual(5000);
    const pecks = sent.filter((l) => /(?<![A-Z])G83(?![0-9])/.test(l));
    expect(pecks.length).toBeGreaterThan(0);
    for (const l of pecks) expect(l).toMatch(/(?<![A-Z])Q2\.?(?![0-9])/);
    // FANUC-2 runs HAAS code: the HAAS end stays.
    expect(sent.join('\n')).toMatch(/G0 G53 G49 Y0 Z0 M89/);
  });

  it('takes the material from CAM AI, not from words in the model\'s name (a review found "POM-PLATE ALU")', () => {
    // A model named after another material: its name comes before the material in the header.
    const named = r.code.replace(/\(([^()]*?)\bALU\b/, '(POM-PLATE ALU');
    expect(named).toContain('POM-PLATE ALU');
    const pecks = (code: string) => code.split('\n').filter((l) => /(?<![A-Z])G83(?![0-9])/.test(l));
    for (const l of pecks(forMachine(named, 'FANUC-2', 'O0001.NC', 'ALU'))) expect(l).toMatch(/(?<![A-Z])Q2\.?(?![0-9])/);
    // An FH part named like a POM one keeps its pecks to 5 mm.
    const fh = named.replace('POM-PLATE ALU', 'POM-PLATE FH').replace(/(?<![A-Z])Q[\d.]+/g, 'Q8.');
    expect(forMachine(fh, 'HAAS-2', 'O0001.NC', 'FH')).not.toMatch(/(?<![A-Z])Q8/);
  });

  it('numbers a FANUC-2 program as the FANUC files are: no N over 9999, whole coordinates with a dot', () => {
    expect(forMachine(['%', 'O0001', 'N10001 G00 X1 Y2', '%'].join('\n'), 'FANUC-2', 'O0001.NC')).toBe(['%', 'O0001', 'N9999 G00 X1. Y2.', '%'].join('\n'));
  });
});
