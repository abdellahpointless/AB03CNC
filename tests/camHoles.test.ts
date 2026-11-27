import { beforeAll, describe, expect, it } from 'vitest';
import { simulate } from '../src/lib/cam/holeSim';
import { DEFAULT_LIMITS } from '../src/lib/cam/limits';
import { camProgram, drilling, HOLE_DEFAULTS, holeCycle, microCircle, nearestOrder, opSegments, peckOf, SAFE_START, type CamInput } from '../src/lib/cam/program';
import { shopStyle } from '../src/lib/cam/style';
import { catalog, cutData } from '../src/lib/cam/tools';
import { haasTools } from '../src/lib/defaultTools';
import { plateWithHoles } from './heightPart';

// The owner's hole rules for the VF-4 (2026-11-27): the cycle by depth and material, R just over where the material
// starts, holes in nearest-neighbour order, each tool started safe, T and H within 1-200, a hole a little wider than its
// mill as arcs, not hundreds of tiny G01 moves. `holes: { legacy: true }` writes them as before.

describe('the drilling cycle', () => {
  it('is G81 up to 1 x D, G73 up to 3 x D in short-chip materials, G83 deeper or in the plastics', () => {
    expect(holeCycle(3, 3.3, 'ALU').cycle).toBe('G81');
    expect(holeCycle(9.5, 3.3, 'ALU').cycle).toBe('G73');
    expect(holeCycle(9.5, 3.3, 'POM').cycle).toBe('G83');
    expect(holeCycle(12, 3.3, 'ALU').cycle).toBe('G83');
    expect(holeCycle(12, 3.3, 'ALU', { ...HOLE_DEFAULTS, legacy: true }).cycle).toBe('G83');
    // Every choice says why, in words (no G or X word a reader could take for code).
    for (const why of [holeCycle(3, 3.3, 'ALU').why, holeCycle(9.5, 3.3, 'ALU').why, holeCycle(12, 3.3, 'ALU').why]) expect(why).not.toMatch(/(?<![A-Z])[GXYZ]-?\d/);
  });

  it('orders holes nearest-neighbour from the first', () => {
    const at = (x: number, y: number) => ({ h: { c: [x, y] as [number, number] } });
    expect(nearestOrder([at(0, 0), at(30, 0), at(10, 0), at(20, 0)]).map((x) => x.h.c[0])).toEqual([0, 10, 20, 30]);
  });

  it('sees a circle smaller than the mill (a micro loop), not a bigger ring or a square', () => {
    const ring = (r: number, n = 24, c = [3, -2]) => Array.from({ length: n }, (_, k) => [c[0] + r * Math.cos((2 * Math.PI * k) / n), c[1] + r * Math.sin((2 * Math.PI * k) / n)] as [number, number]);
    const m = microCircle(ring(0.3), 3)!;
    expect(m.r).toBeCloseTo(0.3, 3);
    expect(m.c[0]).toBeCloseTo(3, 3);
    expect(m.ccw).toBe(true);
    expect(microCircle(ring(0.3).reverse(), 3)!.ccw).toBe(false);
    expect(microCircle(ring(4), 3)).toBeNull();
    expect(microCircle([[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0], [1, 0.5]], 3)).toBeNull();
  });
});

describe('the way from hole to hole', () => {
  it('goes back up to the start height before a hole whose way on is not proven clear, after one that stayed at R', () => {
    const drill = catalog('ALU', haasTools).find((t) => t.type === 'SB' && Math.abs(t.diameter - 3.3) < 1e-6)!;
    const hole = (x: number) => ({ h: { c: [x, 0] as [number, number], r: 1.65, top: 0, bottom: -5, through: false, closed: true }, tool: drill, z: -5 });
    // A wall between the second and the third hole: from 1 to 2 the way at R is clear, from 2 to 3 it is not.
    const clearAt = (a: [number, number], b: [number, number]) => Math.max(a[0], b[0]) < 30;
    const [op] = drilling([hole(0), hole(10), hole(50)], undefined, 'ALU', DEFAULT_LIMITS, 2, 0, () => 0, {}, clearAt);
    // A control takes the start height again at each line naming the cycle (the app's reader does): read that way.
    const across = (code: string) => simulate(code).moves.filter((m) => m.kind === 'rapid' && Math.abs(m.to[0] - m.from[0]) > 1e-6).map((m) => [m.to[0], m.to[2]]);
    const raw = ['%', 'O0001', ...['T1 M6', 'G00 G43 H01 Z50. M08', ...op.lines, 'G00 Z50.', 'M30'].map((l, i) => `N${i + 1} ${l}`), '%'].join('\n');
    expect(across(raw)).toEqual([
      [10, 0.5],
      [50, 2],
    ]);
    // And as the shop's shorter program (what Download writes).
    const shop = shopStyle(raw, 'HAAS');
    expect(shop.shortened).toBe(true);
    expect(across(shop.code)).toEqual(across(raw));
  });
});

describe('where a cycle starts', () => {
  it('is R 0.5 over the faced top, and half a grid layer more over a surface known only from the grid of what earlier clampings left', () => {
    const drill = catalog('ALU', haasTools).find((t) => t.type === 'SB' && Math.abs(t.diameter - 3.3) < 1e-6)!;
    const hole = (x: number, top: number) => ({ h: { c: [x, 0] as [number, number], r: 1.65, top, bottom: top - 5, through: false, closed: true }, tool: drill, z: top - 5 });
    // A hole on the faced top (0) and one on a floor 10 mm down that an earlier clampings' grid (0.6 mm layers) shows.
    const [op] = drilling([hole(0, 0), hole(10, -10)], undefined, 'ALU', DEFAULT_LIMITS, 2, 0, (h) => h.top, {}, undefined, (s) => (s >= 0 ? 0 : 0.3));
    const rs = op.lines.filter((l) => /^G9[89] G(8[13]|73) /.test(l)).map((l) => Number(l.match(/ R(-?[\d.]+)/)![1]));
    expect(rs).toEqual([0.5, -9.2]);
  });
});

describe('tool numbers', () => {
  it('stay within 1-200 for every tool the machine does not have (a Haas takes H 1-200)', () => {
    for (const mat of ['ALU', 'POM', 'FH'] as const) for (const t of catalog(mat, haasTools)) expect(t.number, t.code).toBeGreaterThanOrEqual(1), expect(t.number, t.code).toBeLessThanOrEqual(200);
    for (const t of catalog('ALU', [])) expect(t.number, t.code).toBeLessThanOrEqual(200);
  });
});

describe('a program with holes', () => {
  // 40 x 30 x 12 ALU: a Ø3.3 hole through (drilled), a Ø6.6 hole through (no drill of it in HAAS-5: milled by the Ø6).
  const input: CamInput = { tris: plateWithHoles(40, 30, 12, [{ c: [10, 15], d: 3.3 }, { c: [28, 15], d: 6.6 }]), material: 'ALU', tools: haasTools, brand: 'HAAS', raw: [44, 34, 17], orient: { side: 'Z+', spin: false }, noNest: true };
  let now: ReturnType<typeof camProgram>;
  let before: ReturnType<typeof camProgram>;
  beforeAll(() => {
    now = camProgram(input);
    before = camProgram({ ...input, holes: { legacy: true } });
  }, 900_000);

  it('starts every tool safe: the modal line, the first point with the spindle on, then G43 H and coolant', () => {
    const lines = now.code.split('\n').map((l) => l.replace(/^N\d+ /, ''));
    const changes = lines.flatMap((l, i) => (/^T\d+ M6/.test(l) ? [i] : []));
    expect(changes.length).toBeGreaterThan(2);
    for (const i of changes) {
      const t = Number(lines[i].match(/^T(\d+)/)![1]);
      const next = lines.slice(i, i + 12);
      const s = next.indexOf(SAFE_START);
      const g43 = next.findIndex((l) => /^G00 G43 H\d+ Z\d+\. M0?8$/.test(l));
      expect(s, lines[i]).toBeGreaterThan(0);
      expect(g43, lines[i]).toBeGreaterThan(s);
      expect(next[s + 1], lines[i]).toMatch(/^G00 G90 X\S+ Y\S+ S\d+ M0?3$/);
      expect(Number(next[g43].match(/H(\d+)/)![1])).toBe(t);
      expect(t).toBeLessThanOrEqual(200);
    }
    // Legacy: the length first, as before.
    expect(before.code).not.toContain(SAFE_START);
  });

  it('drills from R 0.5 mm over the faced top with the cycle its depth calls for, and says why', () => {
    const drill = now.setups[0].ops.find((o) => o.kind === 'drill' && o.purpose === 'drill')!;
    const cycle = drill.lines.find((l) => /^G9[89] G(8[13]|73) /.test(l))!;
    expect(Number(cycle.match(/ R(-?[\d.]+)/)![1])).toBeCloseTo(0.5, 3);
    // 12.95 deep (12 through, the point out) with a Ø3.3: 3.9 x D in ALU, G83.
    expect(cycle).toMatch(/^G98 G83 /);
    expect(drill.lines.some((l) => /^\(HOLE 1 AT .*PECKS WITH FULL RETRACT/.test(l))).toBe(true);
    const old = before.setups[0].ops.find((o) => o.kind === 'drill' && o.purpose === 'drill')!.lines.find((l) => /G83/.test(l))!;
    expect(Number(old.match(/ R(-?[\d.]+)/)![1])).toBeCloseTo(2, 3);
  });

  it('mills the Ø6.6 hole with arcs (a helix a turn per line), far fewer lines, the part as before', () => {
    const op = (r: ReturnType<typeof camProgram>) => r.setups[0].ops.find((o) => o.tool.diameter === 6 && o.kind !== 'drill')!;
    const g1 = (r: ReturnType<typeof camProgram>) => op(r).lines.filter((l) => /^G01 /.test(l)).length;
    expect(op(now).lines.some((l) => /^G0[23] .*Z-?[\d.]+ I/.test(l))).toBe(true);
    expect(g1(now)).toBeLessThan(g1(before) / 5);
    expect(now.check.match).toBeGreaterThanOrEqual(before.check.match - 0.002);
    expect(now.check.collisions).toBe(0);
    expect(now.check.rapids ?? 0).toBe(0);
  });
});

// You (2026-11-27, an engineer's program for two Ø1 holes): the plastics peck 4 mm; a hole gets the drill of its own Ø,
// else the nearest smaller one down to 0.05 mm under it or a bigger one up to 0.12 over it (its tool says both sizes, in
// yellow), never a smaller drill and
// then a mill to size.
describe('the peck and the drill for a hole (you, 2026-11-27)', () => {
  const drillOf = (mat: 'ALU' | 'POM', d: number) => catalog(mat, haasTools).find((t) => t.type === 'SB' && Math.abs(t.diameter - d) < 1e-6)!;
  const qOf = (lines: string[]) => Number(lines.find((l) => /^G9[89] G83 /.test(l))!.match(/ Q(-?[\d.]+)/)![1]);
  const deep = (tool: ReturnType<typeof drillOf>, d = tool.diameter, pin = false) => ({ h: { c: [0, 0] as [number, number], r: d / 2, top: 0, bottom: -12, through: false, closed: true }, tool, z: -12, pin });

  it('pecks 4 mm in the plastics (4 x Ø at most), the engineers\' own pecks in aluminium', () => {
    expect(peckOf(0.5, 1, 'POM')).toBe(4);
    expect(peckOf(0.5, 0.5, 'PEEK')).toBe(2);
    expect(peckOf(6, 6, 'POM')).toBe(6);
    expect(peckOf(0.3, 1, 'ALU')).toBe(0.3);
    expect(peckOf(0.7, 1.5, 'FH')).toBe(0.7);
    const pom = drillOf('POM', 1);
    expect(qOf(drilling([deep(pom)], undefined, 'POM', DEFAULT_LIMITS, 2, 0, () => 0)[0].lines)).toBe(4);
    const alu = drillOf('ALU', 1);
    expect(qOf(drilling([deep(alu)], undefined, 'ALU', DEFAULT_LIMITS, 2, 0, () => 0)[0].lines)).toBe(cutData(alu, 'drill', 'ALU').q);
  });

  it('says on a drill which holes are not its own Ø (a pin plate\'s drills excepted)', () => {
    const d3 = drillOf('ALU', 3);
    // A Ø3.03 hole: said. One read Ø3.01 or Ø2.99 from the model's facets: its own drill.
    const [near] = drilling([deep(d3, 3.03), deep(d3, 3.01), deep(d3, 2.99)], undefined, 'ALU', DEFAULT_LIMITS, 2, 0, () => 0);
    expect(near.sizes).toEqual([{ d: 3.03, used: 3 }]);
    expect(drilling([deep(d3, 2.98)], undefined, 'ALU', DEFAULT_LIMITS, 2, 0, () => 0)[0].sizes).toEqual([{ d: 2.98, used: 3 }]);
    expect(drilling([deep(d3)], undefined, 'ALU', DEFAULT_LIMITS, 2, 0, () => 0)[0].sizes).toBeUndefined();
    expect(drilling([deep(d3, 3.03, true)], undefined, 'ALU', DEFAULT_LIMITS, 2, 0, () => 0)[0].sizes).toBeUndefined();
  });

  it('drills a Ø3.03 hole with the Ø3 and mills nothing in it after; Ø6.45 with the Ø6.4; Ø6.5 (0.1 over the Ø6.4) is milled', () => {
    const r = camProgram({ tris: plateWithHoles(40, 30, 12, [{ c: [10, 9], d: 3.03 }, { c: [28, 9], d: 6.45 }, { c: [20, 22], d: 6.5 }]), material: 'ALU', tools: [], brand: 'HAAS', raw: [44, 34, 19], orient: { side: 'Z+', spin: false }, noNest: true });
    const ops = r.setups[0].ops;
    const d3 = ops.find((o) => o.kind === 'drill' && Math.abs(o.tool.diameter - 3) < 1e-6)!;
    expect(d3.sizes).toEqual([{ d: 3.03, used: 3 }]);
    const at = d3.lines.find((l) => /^G9[89] G8[13] /.test(l))!;
    const [hx, hy] = ['X', 'Y'].map((k) => Number(at.match(new RegExp(` ${k}(-?[\\d.]+)`))![1]));
    // No mill's feed inside the hole (under the top) once it is drilled.
    for (const o of ops.filter((x) => x.kind === 'pocket' || x.kind === 'finish')) {
      const s = opSegments(o.lines);
      for (let i = 0; i < s.length; i += 3) if (s[i + 2] < -0.05) expect(Math.hypot(s[i] - hx, s[i + 1] - hy), o.name).toBeGreaterThan(1.5 - o.tool.diameter / 2 - 1e-6);
    }
    expect(ops.find((o) => o.kind === 'drill' && Math.abs(o.tool.diameter - 6.4) < 1e-6)?.sizes).toEqual([{ d: 6.45, used: 6.4 }]);
    // The Ø6.5 is milled (the Ø6.4 is 0.1 under it, the Ø7 0.5 over).
    expect(ops.filter((o) => o.kind === 'drill').flatMap((o) => o.sizes ?? []).map((x) => x.d)).not.toContain(6.5);
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
  }, 900_000);
});
