import { describe, expect, it } from 'vitest';
import { forMachine } from '../src/lib/cam/export';
import { camProgram, zigzag, type CamSetup } from '../src/lib/cam/program';
import { simplify, type P2 } from '../src/lib/cam/geom';
import { LIBRARY } from '../src/lib/cam/tools';
import { parseToolpath, speedsFor } from '../src/lib/toolpath';
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
    // Raw 22 high: 6 mm under the part in the first clamping, gripped 5 mm, so its outside goes 0.2 mm under the part.
    const r = camProgram({ ...base, tris: twoSided, raw: [34, 28, 22] });
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

describe('going down into material', () => {
  /** The steepest and the least steep ramp (its whole drop over its whole length: the lines are rounded to 0.001 mm; over 2 mm long for the least) of each end mill's roughing, by tool code. */
  const slopes = (r: ReturnType<typeof camProgram>) => {
    const out = new Map<string, { type: string; d: number; max: number; min: number }>();
    for (const o of r.setups.flatMap((s) => s.ops).filter((x) => x.name.startsWith('FRAESEN'))) {
      const e = out.get(o.tool.code) ?? out.set(o.tool.code, { type: o.tool.type, d: o.tool.diameter, max: 0, min: Infinity }).get(o.tool.code)!;
      let [dz, len] = [0, 0];
      for (const m of [...feeds(o.lines), null]) {
        const dxy = m ? Math.hypot(m[1][0] - m[0][0], m[1][1] - m[0][1]) : 0;
        if (m && dxy > 1e-6 && m[0][2] - m[1][2] > 1e-6) [dz, len] = [dz + m[0][2] - m[1][2], len + dxy];
        else {
          if (len > 0.5) e.max = Math.max(e.max, dz / len);
          if (len > 2) e.min = Math.min(e.min, dz / len);
          [dz, len] = [0, 0];
        }
      }
    }
    return [...out.values()].filter((e) => e.max > 0);
  };
  const tan = (deg: number) => Math.tan((deg * Math.PI) / 180);

  it('zigzags down a piece shorter than its ramp as steeply as it may, no longer than it needs, back at its start', () => {
    const slope = tan(15);
    for (const piece of [
      [[0, 0], [1.2, 0]],
      [[0, 0], [0.7, 0], [0.7, 0.6]],
      [[0, 0], [5, 0]],
    ] as [number, number][][]) {
      const z = zigzag(piece, 0, -1, slope);
      let [len, p, zPrev] = [0, piece[0] as [number, number], 0];
      for (const q of z) {
        const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        expect(zPrev - q[2]).toBeLessThanOrEqual(d * slope + 1e-9);
        expect(q[2]).toBeLessThanOrEqual(zPrev + 1e-12);
        [len, p, zPrev] = [len + d, [q[0], q[1]], q[2]];
      }
      expect(len).toBeCloseTo(1 / slope, 6);
      expect(z.at(-1)).toEqual([0, 0, -1]);
    }
  });

  it('ramps at 15° with the end mills the shop takes in that steeply (ALU Ø2 to 8), at 5° with the high-feed mill and where the shop never does', () => {
    const r = camProgram({ ...base, tris: plate, raw: [44, 34, 16] });
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
    const s = slopes(r);
    const steep = s.filter((e) => e.type === 'SF' && e.d >= 2 && e.d <= 8);
    expect(steep.length).toBeGreaterThan(0);
    for (const e of steep) expect(e.max, `SF ${e.d}`).toBeLessThanOrEqual(tan(15) + 0.001);
    expect(Math.max(...steep.map((e) => e.max))).toBeGreaterThan(tan(10));
    // Every ramp, round a ring or back and forth along a piece, as steep as it may be: no longer than it needs.
    for (const e of steep.filter((x) => Number.isFinite(x.min))) expect(e.min, `SF ${e.d}`).toBeGreaterThanOrEqual(tan(15) - 0.003);
    for (const e of s.filter((x) => x.type !== 'SF' || x.d < 2 || x.d > 8)) expect(e.max, `${e.type} ${e.d}`).toBeLessThanOrEqual(tan(5) + 0.001);
    // Brass: no ramp or plunge into material in the shop's programs to go by: 5° throughout.
    const ms = camProgram({ ...base, material: 'MS', tris: plate, raw: [44, 34, 16] });
    expect(slopes(ms).length).toBeGreaterThan(0);
    for (const e of slopes(ms)) expect(e.max, `MS ${e.type} ${e.d}`).toBeLessThanOrEqual(tan(5) + 0.001);
  }, 300_000);
});

describe('entering a ring from the side', () => {
  it('goes down by rapid in the ring already cut and feeds only the last mm (the shop rapids to 2 mm above and feeds in)', () => {
    for (const [tris, raw] of [
      [plate, [44, 34, 16]],
      [twoSided, [34, 28, 20]],
    ] as const) {
      const r = camProgram({ ...base, tris, raw: [...raw] });
      expect(r.check.match).toBeGreaterThanOrEqual(0.99);
      expect(r.check.collisions).toBe(0);
      let entries = 0;
      for (const o of r.setups.flatMap((s) => s.ops).filter((x) => x.kind === 'pocket' || x.kind === 'finish'))
        // A rapid down, a feed down, then across at that height (into the ring): the feed down is the last mm.
        o.lines.forEach((l, i) => {
          const zOf = (s: string) => Number(s.match(/Z(-?[\d.]+)/)?.[1]);
          const [next, after] = [o.lines[i + 1] ?? '', o.lines[i + 2] ?? ''];
          if (/^G00 Z/.test(l) && /^G01 Z\S+( F\S+)?$/.test(next) && /^G01 [XY]/.test(after) && !/Z/.test(after)) {
            entries++;
            expect(zOf(l) - zOf(next), `${o.name} line ${i}`).toBeLessThanOrEqual(1.001);
          }
        });
      expect(entries).toBeGreaterThan(0);
    }
  }, 300_000);

  it('never runs back over a cut at feed: an open piece’s zigzag down ends at its start, where its pass begins (the shop’s zigzag, no walk back)', () => {
    for (const [tris, raw] of [
      [plate, [44, 34, 16]],
      [twoSided, [34, 28, 20]],
    ] as const) {
      const r = camProgram({ ...base, tris, raw: [...raw] });
      expect(r.check.match).toBeGreaterThanOrEqual(0.99);
      expect(r.check.collisions).toBe(0);
      for (const o of r.setups.flatMap((s) => s.ops).filter((x) => x.kind === 'pocket' || x.kind === 'finish')) {
        const f = feeds(o.lines);
        f.forEach(([a, b], i) => {
          const p = f[i - 1];
          const back = !!p && Math.hypot(...([0, 1, 2] as const).map((k) => a[k] - p[1][k])) < 1e-6 && Math.hypot(...([0, 1, 2] as const).map((k) => b[k] - p[0][k])) < 1e-6;
          expect(back, `${o.name}: back over a cut at feed to ${b.map((v) => v.toFixed(3))}`).toBe(false);
        });
      }
    }
  }, 300_000);
});

describe('fewer points', () => {
  const near = (p: P2, a: P2, b: P2) => {
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  };
  const off = (orig: P2[], out: P2[], closed: boolean) => {
    const segs = out.map((p, i) => [p, out[i + 1] ?? (closed ? out[0] : p)] as [P2, P2]);
    return Math.max(...orig.map((p) => Math.min(...segs.map(([a, b]) => near(p, a, b)))));
  };

  it('keeps every point of a path within the tolerance of the path written, its ends and a loop’s start', () => {
    // A circle of 2,000 points (Clipper's arcs), a straight run with micro-steps, an L.
    const circle = Array.from({ length: 2000 }, (_, i) => [10 * Math.cos((i * Math.PI) / 1000), 10 * Math.sin((i * Math.PI) / 1000)] as P2);
    const c = simplify(circle, 0.005, true);
    expect(c.length).toBeLessThan(200);
    expect(c[0]).toEqual(circle[0]);
    expect(off(circle, c, true)).toBeLessThanOrEqual(0.005 + 1e-9);
    const run = Array.from({ length: 101 }, (_, i) => [i * 0.1, i % 2 ? 0.001 : 0] as P2);
    expect(simplify(run, 0.005, false)).toEqual([run[0], run[100]]);
    const L: P2[] = [[0, 0], [5, 0], [5, 0.004], [5, 5]];
    const l = simplify(L, 0.005, false);
    expect(l).toEqual([[0, 0], [5, 0], [5, 5]]);
    expect(simplify([[0, 0], [1, 1]], 0.005, false)).toEqual([[0, 0], [1, 1]]);
  });

  it('writes a finely faceted round wall with as few points as keep it within 0.005 mm (roughing), not every facet', () => {
    // A Ø30 x 12 cylinder of 1,000 facets (a 3D model's round faces).
    const N = 1000;
    const p = (i: number, z: number) => [15 + 15 * Math.cos((2 * Math.PI * i) / N), 15 + 15 * Math.sin((2 * Math.PI * i) / N), z];
    const t: number[] = [];
    for (let i = 0; i < N; i++) t.push(15, 15, 12, ...p(i, 12), ...p(i + 1, 12), 15, 15, 0, ...p(i + 1, 0), ...p(i, 0), ...p(i, 0), ...p(i + 1, 0), ...p(i + 1, 12), ...p(i, 0), ...p(i + 1, 12), ...p(i, 12));
    const r = camProgram({ ...base, tris: new Float32Array(t), raw: [34, 34, 16] });
    expect(r.check.match).toBeGreaterThanOrEqual(0.99);
    expect(r.check.collisions).toBe(0);
    // The longest run of moves at one height in a roughing op: one ring round the cylinder.
    let most = 0;
    for (const o of r.setups.flatMap((s) => s.ops).filter((x) => x.name.startsWith('FRAESEN'))) {
      let run = 0;
      for (const [a, b] of feeds(o.lines)) {
        run = Math.abs(a[2] - b[2]) < 1e-9 && Math.hypot(b[0] - a[0], b[1] - a[1]) > 0 ? run + 1 : 0;
        most = Math.max(most, run);
      }
    }
    expect(most).toBeGreaterThan(50);
    expect(most).toBeLessThan(400);
    // Its rings written as whole circles (G02/G03 back to the start, as the shop does), the same on a FANUC.
    const tp = parseToolpath(r.code, speedsFor('HAAS'));
    expect(tp.moves.filter((m) => m.kind === 'feed' && m.points.length > 2 && Math.hypot(m.points[0][0] - m.points.at(-1)![0], m.points[0][1] - m.points.at(-1)![1]) < 1e-6).length).toBeGreaterThan(0);
    const fanuc = parseToolpath(forMachine(r.code, 'FANUC-1', 'O0001.NC'), speedsFor('FANUC'));
    const length = (t: typeof tp) => t.moves.filter((m) => m.kind === 'feed').reduce((a, m) => a + m.length, 0);
    expect(length(fanuc)).toBeCloseTo(length(tp), 1);
  }, 300_000);
});
