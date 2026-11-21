import { describe, expect, it } from 'vitest';
import { forMachine } from '../src/lib/cam/export';
import { camProgram } from '../src/lib/cam/program';
import { catalog } from '../src/lib/cam/tools';
import { defaultToolbox } from '../src/lib/defaultTools';
import { analyzeGCode, applyG53BeforeG52, generateRemappedCode, isHaasDialectForFanuc } from '../src/lib/gcodeProcessor';
import { convertHaasToFanuc } from '../src/lib/haasToFanucConverter';
import { parseToolpath, speedsFor, type Move } from '../src/lib/toolpath';
import type { Tool } from '../src/types';
import { pocketWithHole } from './heightPart';

/**
 * What Send gives the machine with the tools CAM AI chose: the program into the remapper, Process, Export
 * (ToolRemapper.tsx). The app's Process picks the tools again from the machine's inventory and its rules
 * (HAAS-1's T2 and T21 for the Ø16 mills): tool numbers are not what these tests compare.
 */
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

  it('gives each machine the same code as Send and Process in the remapper, with the tools CAM AI chose, FH pecks included', () => {
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

describe("CAM AI's tool numbers are the machine's (decision 9)", () => {
  /** Send with the machine's inventory and nothing picked by hand: Process matches every tool itself. */
  const sendAuto = (code: string, machine: string, tools: Tool[]) => {
    let src = code;
    if (machine.startsWith('FANUC') && machine !== 'FANUC-2' && isHaasDialectForFanuc(src)) src = convertHaasToFanuc(src, 'O0001.NC').fanucCode;
    src = applyG53BeforeG52(src.split('\n')).lines.join('\n');
    const a = analyzeGCode(src, tools, machine);
    return applyG53BeforeG52(generateRemappedCode(a.lines, a.blocks, {}, machine).finalCode.split('\n')).lines.join('\n');
  };
  const part = pocketWithHole(40, 30, 12, [10, 8, 30, 22], 6, { c: [20, 15], d: 4 });
  const numbers = (code: string) => [...new Set(code.split('\n').flatMap((l) => [...l.replace(/\([^)]*\)/g, '').matchAll(/(?<![A-Z])T(\d+)/g)].map((m) => Number(m[1]))))];

  for (const machine of ['HAAS-1', 'FANUC-1']) {
    it(`plans with ${machine}'s own tools and numbers, and Send keeps them`, () => {
      const tools = defaultToolbox[machine]!;
      // Only what the machine holds: every template tool it lacks is left out.
      const exclude = catalog('ALU', tools).filter((t) => !t.inMachine).map((t) => t.code);
      const r = camProgram({ tris: part, material: 'ALU', tools, brand: 'HAAS', raw: [44, 34, 16], noNest: true, exclude });
      expect(r.check.match).toBeGreaterThanOrEqual(0.99);
      for (const s of r.setups) for (const o of s.ops) expect(o.tool.inMachine, o.tool.code).toBe(true);
      const own = new Set(tools.map((t) => t.number));
      for (const n of numbers(r.code)) expect(own.has(n), `T${n}`).toBe(true);
      // The face mill is the machine's (its length is not in the inventory).
      const face = tools.find((t) => t.category === 'tourteau' && t.diameter === 40)!;
      expect(numbers(r.code)).toContain(face.number);
      // Download and Send give the same code, tool numbers included.
      expect(codeOf(forMachine(r.code, machine, 'O0001.NC')), machine).toEqual(codeOf(sendAuto(r.code, machine, tools)));
    }, 600_000);
  }

  it("follows HAAS-1's rule for its two Ø16 mills: roughing with T2, finishing with T21, whatever the inventory's order", () => {
    const own = defaultToolbox['HAAS-1']!;
    // As listed, and with T2 last (deleted and added again, or imported in another order: a review found the order decided).
    for (const tools of [own, [...own.filter((t) => t.number !== 2), own.find((t) => t.number === 2)!]]) {
      const ofType = (type: string) => catalog('ALU', tools).filter((t) => t.type === type && t.diameter === 16 && t.inMachine);
      expect(ofType('SFH').map((t) => t.number)).toEqual([2]);
      expect(ofType('SF').map((t) => t.number)).toContain(21);
      expect(ofType('SF').map((t) => t.number)).not.toContain(2);
    }
  });

  it('roughs a top plate on HAAS-1 with T2 and finishes it with T21, also when T2 is listed last', () => {
    const own = defaultToolbox['HAAS-1']!;
    const tools = [...own.filter((t) => t.number !== 2), own.find((t) => t.number === 2)!];
    const top = pocketWithHole(60, 40, 12, [10, 8, 50, 32], 6, { c: [5, 5], d: 3 });
    const r = camProgram({ tris: top, material: 'ALU', tools, brand: 'HAAS', raw: [64, 44, 16], noNest: true, partType: 'topPlate', orient: { side: 'Z+', spin: false } });
    const ops = r.setups.flatMap((s) => s.ops);
    for (const o of ops.filter((x) => x.name === 'FRAESEN_16MM')) expect(o.tool.number).toBe(2);
    const fin = ops.filter((x) => x.name === 'SCHLICHTEN_16MM');
    expect(fin.length).toBeGreaterThan(0);
    for (const o of fin) expect(o.tool.number).toBe(21);
  }, 600_000);
});
