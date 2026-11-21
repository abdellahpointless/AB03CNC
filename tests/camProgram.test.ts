import { describe, expect, it } from 'vitest';
import { GOUGE_MM3 } from '../src/lib/cam/limits';
import { camProgram, gougeOf } from '../src/lib/cam/program';
import { LIBRARY } from '../src/lib/cam/tools';
import { heightPart } from './heightPart';
import type { Tool } from '../src/types';

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
    // G53 Y0 before each flip and the end, never before the first clamping.
    const lines = r.code.split('\n');
    expect(lines.slice(0, lines.findIndex((l) => /G52/.test(l))).some((l) => /G53 Y0/.test(l))).toBe(false);
    expect(lines.filter((l) => /G53 (G49 )?Y0/.test(l))).toHaveLength(r.setups.length);
    // The shop's end: table out, offset cancelled, through-spindle coolant off, the machining time.
    expect(lines.slice(-5, -1).map((l) => l.replace(/^N\d+ /, ''))).toEqual(['M09', 'G0 G53 G49 Y0 Z0 M89', `( Gesamt-Bearbeitungszeit =${(Math.round(r.check.minutes * 10) / 10).toFixed(1)}MIN )`, 'M30']);
    // A flip comes after the next tool change (which stops the spindle and the coolant), never with the spindle on.
    lines.forEach((l, i) => {
      if (!/G53 Y0/.test(l) || /M30/.test(lines[i + 1] ?? '')) return;
      let k = i - 1;
      while (/^N\d+ \(/.test(lines[k])) k--;
      expect(lines[k]).toMatch(/T\d+ M6$/);
    });
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

  it('roughs with the SFH 16 and finishes its walls with the SF 16, as the shop does (T4, S4)', () => {
    // No part family given: every part gets the finishing pass (the shop: 75 of 92 parts).
    const r = camProgram({ tris: plate, material: 'ALU', tools: [], brand: 'HAAS', raw: [44, 34, 16], noNest: true, orient: { side: 'Z+', spin: false } });
    const ops = r.setups.flatMap((s) => s.ops);
    const rough = ops.filter((o) => o.name === 'FRAESEN_16MM');
    expect(rough.length).toBeGreaterThan(0);
    // The SFH 16 has the shop's roughing data (2,800 mm/min); the SF 16 only its finishing (850).
    for (const o of rough) expect(o.tool.code).toMatch(/^SFH_16\./);
    const finish = ops.filter((o) => o.name === 'SCHLICHTEN_16MM');
    expect(finish.length).toBeGreaterThan(0);
    for (const o of finish) expect(o.tool.code).toMatch(/^SF_16\./);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
  }, 300_000);

  it('deburrs the sharp edges facing up, last in every clamping, with the 90° graver (S5: the shop’s ENTGRATEN, 0.3 deep, 0.2 off the edge)', () => {
    const r = camProgram({ tris: plate, material: 'ALU', tools: [], brand: 'HAAS', raw: [44, 34, 16], noNest: true, orient: { side: 'Z+', spin: false } });
    for (const s of r.setups) {
      const last = s.ops[s.ops.length - 1];
      expect(last.name, s.side).toBe('ENTGRATEN');
      expect(last.tool.type).toBe('ST');
      expect(last.lines.some((l) => /^G01 Z-0\.3 F/.test(l))).toBe(true);
    }
    // A 0.1 mm break of the edge: within what the check reads as the model's own surface.
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
    expect(gougeOf(r.check)).toBeLessThan(GOUGE_MM3);
  }, 300_000);

  it('leaves out a move to where the tool already is (improvement O1, approved)', () => {
    const r = camProgram({ tris: plate, material: 'ALU', tools: [], brand: 'HAAS', raw: [44, 34, 16], noNest: true, orient: { side: 'Z+', spin: false } });
    const code = r.code.split('\n').map((l) => l.replace(/^N\d+ /, ''));
    // The same rapid twice in a row (CAM AI wrote G00 Z4.5 so): the second moves nothing.
    expect(code.filter((l, i) => i > 0 && /^G0?0( [XYZ]-?[\d.]+)+$/.test(l) && l === code[i - 1])).toEqual([]);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
  }, 300_000);

  it('never uses a tool the operator does not have', () => {
    const exclude = LIBRARY.ALU.filter((t) => t.type.startsWith('SF') && t.d === 16).map((t) => t.code);
    const r = camProgram({ tris: plate, material: 'ALU', tools, brand: 'HAAS', raw: [44, 34, 16], exclude });
    expect(r.code).not.toMatch(/_16\.00_/);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
  }, 180_000);
});
