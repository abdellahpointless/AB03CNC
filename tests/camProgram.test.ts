import { describe, expect, it } from 'vitest';
import { camProgram } from '../src/lib/cam/program';
import { LIBRARY } from '../src/lib/cam/tools';
import type { Tool } from '../src/types';

/** A 2.5D part from heights on a 1 mm grid (cell i, j is h[j][i] tall): its closed mesh. */
function heightPart(h: number[][]): Float32Array {
  const ny = h.length;
  const nx = h[0].length;
  const at = (i: number, j: number) => (i < 0 || j < 0 || i >= nx || j >= ny ? 0 : h[j][i]);
  const t: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => t.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const z = at(i, j);
      quad([i, j, z], [i + 1, j, z], [i + 1, j + 1, z], [i, j + 1, z]);
      quad([i, j, 0], [i, j + 1, 0], [i + 1, j + 1, 0], [i + 1, j, 0]);
      // Walls down to each lower neighbour (or the floor at the edge), facing it.
      const e = at(i + 1, j);
      if (e < z) quad([i + 1, j, e], [i + 1, j + 1, e], [i + 1, j + 1, z], [i + 1, j, z]);
      const w = at(i - 1, j);
      if (w < z) quad([i, j, w], [i, j, z], [i, j + 1, z], [i, j + 1, w]);
      const n = at(i, j + 1);
      if (n < z) quad([i, j + 1, n], [i, j + 1, z], [i + 1, j + 1, z], [i + 1, j + 1, n]);
      const s = at(i, j - 1);
      if (s < z) quad([i, j, s], [i + 1, j, s], [i + 1, j, z], [i, j, z]);
    }
  return new Float32Array(t);
}

// A 40x30x12 plate with a 20x12 pocket 6 deep in its top.
const plate = heightPart(Array.from({ length: 30 }, (_, j) => Array.from({ length: 40 }, (_, i) => (i >= 10 && i < 30 && j >= 9 && j < 21 ? 6 : 12))));
const tool = (number: number, category: Tool['category'], diameter: number, length: number): Tool => ({ id: `t${number}`, number, category, description: '', diameter, length });
const tools = [tool(1, 'tourteau', 40, 30), tool(2, 'fraise', 10, 40), tool(3, 'fraise', 4, 25)];
const ALU_CODES = new Set(LIBRARY.ALU.map((t) => t.code));

describe('CAM AI', () => {
  it('programs a plate with a pocket that the simulation proves right, with the shop tools only', () => {
    const r = camProgram({ tris: plate, material: 'ALU', tools, brand: 'HAAS', name: 'PLATE', raw: [44, 34, 16], limits: { maxRpm: 12000, maxFeed: 10000 } });
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
    // Faced, cut, written like the shop's programs and read back as such.
    expect(r.code).toMatch(/\(TOOLPATH PLAN\)/);
    expect(r.code).toMatch(/M0 \(TEIL MIT 44 IN X UND 34 IN Y EINSPANNEN/);
    expect(r.code).toMatch(/G52 X/);
    expect(r.code.trim().split('\n').at(-2)).toMatch(/M30$/);
    // Only the shop's template tools, or the machine's own special tools (its Ø10 and Ø4 × 25).
    for (const s of r.setups) for (const o of s.ops) expect(ALU_CODES.has(o.tool.code) || (o.tool.inMachine && [2, 3].includes(o.tool.number))).toBe(true);
    // Never over the machine's top rpm.
    for (const m of r.code.matchAll(/S(\d+) M03/g)) expect(Number(m[1])).toBeLessThanOrEqual(12000);
    // The largest end mill first in each setup.
    for (const s of r.setups) {
      const mills = s.ops.filter((o) => o.name.startsWith('FRAESEN')).map((o) => o.tool.diameter);
      expect(mills).toEqual([...mills].sort((a, b) => b - a));
    }
  }, 180_000);

  it('never uses a tool the operator does not have', () => {
    const exclude = LIBRARY.ALU.filter((t) => t.type.startsWith('SF') && t.d === 16).map((t) => t.code);
    const r = camProgram({ tris: plate, material: 'ALU', tools, brand: 'HAAS', raw: [44, 34, 16], exclude });
    expect(r.code).not.toMatch(/_16\.00_/);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
  }, 180_000);
});
