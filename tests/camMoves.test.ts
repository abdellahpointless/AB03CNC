import { describe, expect, it } from 'vitest';
import { camProgram, type CamSetup } from '../src/lib/cam/program';
import { LIBRARY } from '../src/lib/cam/tools';
import { columnPart, heightPart, plateWithHoles } from './heightPart';

// How CAM AI moves the tool between and into its cuts, against the engineers' programs (Phase 6).

// A 40x30x12 plate with a 20x12 pocket 6 deep in its top.
const plate = heightPart(Array.from({ length: 30 }, (_, j) => Array.from({ length: 40 }, (_, i) => (i >= 10 && i < 30 && j >= 9 && j < 21 ? 6 : 12))));
// A 30x24x10 block with a pocket in each face: 10x8, 4 deep on top; 8x6, 3 deep underneath.
const twoSided = columnPart(
  Array.from({ length: 24 }, (_, j) => Array.from({ length: 30 }, (_, i) => (i >= 16 && i < 24 && j >= 12 && j < 18 ? 3 : 0))),
  Array.from({ length: 24 }, (_, j) => Array.from({ length: 30 }, (_, i) => (i >= 4 && i < 14 && j >= 4 && j < 12 ? 6 : 10))),
);
const base = { material: 'ALU' as const, tools: [], brand: 'HAAS', noNest: true, orient: { side: 'Z+', spin: false } };

/** Each straight feed move of an op: from and to (x, y, z; the op's lines are absolute, every one with its G code). */
function feeds(lines: string[]): [number, number, number][][] {
  let p: [number, number, number] = [NaN, NaN, NaN];
  const out: [number, number, number][][] = [];
  for (const l of lines) {
    const v = (a: string, was: number) => Number(l.match(new RegExp(`${a}(-?[\\d.]+)`))?.[1] ?? was);
    const q: [number, number, number] = [v('X', p[0]), v('Y', p[1]), v('Z', p[2])];
    if (/^G0?1\b/.test(l)) out.push([p, q]);
    p = q;
  }
  return out;
}

/** The face mill's passes at Z0 cover the whole stock (its box in the clamping's frame, every 0.25 mm). */
function facedAll(s: CamSetup): boolean {
  const op = s.ops.find((o) => o.kind === 'face')!;
  const r = op.tool.diameter / 2;
  const at0 = feeds(op.lines).filter(([a, b]) => Math.abs(a[2]) < 1e-6 && Math.abs(b[2]) < 1e-6);
  const near = (x: number, y: number) =>
    at0.some(([a, b]) => {
      const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy) <= r;
    });
  const [x0, y0, x1, y1] = s.box;
  for (let x = x0; x <= x1 + 1e-9; x += 0.25) for (let y = y0; y <= y1 + 1e-9; y += 0.25) if (!near(x, y)) return false;
  return true;
}

describe('milling after the face is cut', () => {
  it('cuts nothing above Z0 once the face mill has taken it (shop: strategy.faceFirst), and from the raw top when the operator removed the facing', () => {
    const r = camProgram({ ...base, tris: plate, raw: [44, 34, 16] });
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
    // The operations in the program in the order planned (the facing first in its clamping).
    expect([...r.code.matchAll(/\(TOOLPATH ([^)]+)\)/g)].map((m) => m[1])).toEqual(r.setups.flatMap((s) => s.ops.map((o) => o.name)));
    const faced = r.setups.filter((s) => s.ops.some((o) => o.kind === 'face'));
    expect(faced.length).toBe(2);
    for (const s of faced) {
      expect(s.ops[0].kind, s.side).toBe('face');
      // Nothing stands above Z0 after the facing: its passes at Z0 cover the whole stock.
      expect(facedAll(s), s.side).toBe(true);
      for (const o of s.ops.filter((x) => x.kind === 'pocket' || x.kind === 'finish')) expect(Math.max(...feeds(o.lines).map(([, b]) => b[2])), `${s.side} ${o.name}`).toBeLessThanOrEqual(0.001);
    }
    // The operator removed the facing of the first clamping: its milling starts at the raw top (2 mm above Z0).
    const kept = camProgram({ ...base, tris: plate, raw: [44, 34, 16], skip: [r.setups[0].ops[0].key!] });
    expect(kept.setups[0].ops.some((o) => o.kind === 'face')).toBe(false);
    expect(Math.max(...kept.setups[0].ops.filter((o) => o.kind === 'pocket').flatMap((o) => feeds(o.lines).map(([, b]) => b[2])))).toBeGreaterThan(0.5);
  }, 600_000);

  it('faces the whole stock with the largest end mill when there is no face mill', () => {
    const r = camProgram({ ...base, tris: plate, raw: [44, 34, 16], exclude: LIBRARY.ALU.filter((t) => t.type === 'MK').map((t) => t.code) });
    const faced = r.setups.filter((s) => s.ops.some((o) => o.kind === 'face'));
    expect(faced.length).toBe(2);
    for (const s of faced) {
      expect(s.ops[0].tool.type, s.side).not.toBe('MK');
      expect(facedAll(s), s.side).toBe(true);
    }
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
  }, 300_000);

  it('plans no rings round a later clamping’s outside that the first clamping already cut through', () => {
    // Raw 20 high: 5 mm under the part in the first clamping, gripped 4 mm, so its outside goes 0.2 mm under the part.
    const r = camProgram({ ...base, tris: twoSided, raw: [34, 28, 20] });
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
    expect(r.setups.map((s) => s.side)).toEqual(['Z+', 'Z-']);
    const mills = (s: CamSetup) => s.ops.filter((o) => o.name.startsWith('FRAESEN'));
    expect(Math.min(...mills(r.setups[0]).flatMap((o) => feeds(o.lines).map(([, b]) => b[2])))).toBeLessThanOrEqual(-10.15);
    // Turned over, only the 8x6 pocket is left to mill: every end mill stays over the part (the held band is the part).
    const [x0, y0, x1, y1] = r.setups[1].held;
    for (const o of mills(r.setups[1]))
      for (const [, b] of feeds(o.lines)) {
        expect(b[0], o.name).toBeGreaterThanOrEqual(x0 - 0.5);
        expect(b[0], o.name).toBeLessThanOrEqual(x1 + 0.5);
        expect(b[1], o.name).toBeGreaterThanOrEqual(y0 - 0.5);
        expect(b[1], o.name).toBeLessThanOrEqual(y1 + 0.5);
      }
  }, 300_000);
});

describe('the plane between cuts', () => {
  // The rapids' heights in one clamping's operations after its facing: the lifts (G00 Z) and each drill cycle's start (its R).
  const lifts = (s: CamSetup) => s.ops.filter((o) => o.kind !== 'face').flatMap((o) => o.lines.flatMap((l) => (/^G00 Z/.test(l) ? [Number(l.match(/Z(-?[\d.]+)/)![1])] : [])));
  const rPlanes = (s: CamSetup) => s.ops.flatMap((o) => o.lines.flatMap((l) => (/ R(-?[\d.]+)/.test(l) ? [Number(l.match(/ R(-?[\d.]+)/)![1])] : [])));

  it('is Z2, 2 mm above the faced top, for every operation after the facing and every drill cycle (the shop’s links and R2)', () => {
    // A Ø3.3 and a Ø5 hole through a 40 x 30 x 8 plate, 2 mm of stock on top.
    const holed = plateWithHoles(40, 30, 8, [{ c: [10, 15], d: 3.3 }, { c: [30, 15], d: 5 }]);
    const r = camProgram({ ...base, tris: holed, raw: [44, 34, 12] });
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
    const s = r.setups[0];
    expect(s.ops[0].kind).toBe('face');
    expect(s.ops.some((o) => o.kind === 'drill')).toBe(true);
    expect(Math.max(...lifts(s))).toBeCloseTo(2, 3);
    for (const z of rPlanes(s)) expect(z).toBeLessThanOrEqual(2.001);
    // The cycles start from Z2: the move before each G98 G8x.
    for (const o of s.ops.filter((x) => x.kind === 'drill' || x.kind === 'centre')) expect(o.lines[o.lines.findIndex((l) => /G98 G8/.test(l)) - 1]).toBe('G00 Z2.');
    // The facing removed by the operator: the raw top stays, the plane stays 2 mm above it (Z4).
    const kept = camProgram({ ...base, tris: holed, raw: [44, 34, 12], skip: [s.ops[0].key!] });
    expect(Math.max(...lifts(kept.setups[0]))).toBeCloseTo(4, 3);
  }, 300_000);
});
