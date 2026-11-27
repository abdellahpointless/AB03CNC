import { beforeAll, describe, expect, it } from 'vitest';
import { simulate } from '../src/lib/cam/holeSim';
import { DEFAULT_LIMITS } from '../src/lib/cam/limits';
import { camProgram, drilling, HOLE_DEFAULTS, holeCycle, microCircle, nearestOrder, SAFE_START, type CamInput } from '../src/lib/cam/program';
import { shopStyle } from '../src/lib/cam/style';
import { catalog } from '../src/lib/cam/tools';
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
