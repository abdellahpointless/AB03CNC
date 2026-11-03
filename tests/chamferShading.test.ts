import { describe, expect, it } from 'vitest';
import { carve, mesher, SUB, type SimInput } from '../src/lib/stockSim';
import { ARC_TOLERANCE } from '../src/lib/toolpath';

/*
 * Chamfers and drilled holes must come out clean in the 3D view: on a 24 × 24 × 10 block at the
 * viewer's sample spacing (0.355 mm, a 104 × 54 × 40 plate at 5 M samples), every triangle on the
 * top face, a 45° chamfer, the wall below it and a pocket's floor is shaded with the normal of the
 * surface it lies on, and none cuts across an edge or an inside corner.
 */

type V = [number, number, number];
const T = 10;
const CX = 12.13;
const CY = 11.87;
const DRILL = Math.tan((59 * Math.PI) / 180);

const ring = (R: number, z: number): V[] => {
  const n = Math.ceil((2 * Math.PI) / (2 * Math.acos(1 - ARC_TOLERANCE / R)));
  return Array.from({ length: n + 1 }, (_, i) => [CX + R * Math.cos((2 * Math.PI * i) / n), CY + R * Math.sin((2 * Math.PI * i) / n), z] as V);
};

type Kind = 'hole' | 'pocket' | 'straight';
/** A hole (drilled), round pocket or straight wall of radius r, chamfered c mm by a 90° tool: plunged, or run round the edge. */
/** T: the top face, face-milled from a 10.4 mm block (so it falls anywhere between two sample layers). */
function scene(kind: Kind, r: number, c: number, by: 'plunge' | 'round', T = 10, skim = 0) {
  const tools = [
    { tool: 1, radius: r, slope: DRILL },
    { tool: 2, radius: 2, slope: 1 },
    { tool: 3, radius: 5, slope: 1 },
    { tool: 4, radius: 3, slope: null },
    { tool: 5, radius: 30, slope: null },
  ];
  const moves: SimInput['moves'] = [{ setup: 0, tool: 5, points: [[-35, 12, T + 5], [-35, 12, T], [60, 12, T]] }];
  let floor = 0;
  if (kind === 'hole') moves.push({ setup: 0, tool: 1, points: [[CX, CY, T + 2], [CX, CY, -1]] });
  else if (kind === 'pocket') {
    moves.push({ setup: 0, tool: 4, points: [[CX, CY, T + 2], [CX, CY, T - 4], ...ring(r - 3, T - 4)] });
    floor = T - 4;
  } else {
    moves.push({ setup: 0, tool: 4, points: [[-5, 15.1, T + 2], [-5, 15.1, T - 4], [29, 15.1, T - 4]] });
    floor = T - 4;
  }
  if (by === 'plunge') moves.push({ setup: 0, tool: 3, points: [[CX, CY, T + 2], [CX, CY, T - (r + c)]] });
  else if (kind === 'straight') moves.push({ setup: 0, tool: 2, points: [[-5, 12.1, T + 1], [-5, 12.1, T - c], [29, 12.1, T - c]] });
  else {
    const rr = ring(r, T - c);
    moves.push({ setup: 0, tool: 2, points: [[rr[0][0], rr[0][1], T + 1], ...rr] });
  }
  // A face mill skimming the top after the chamfer (as the shop's programs do last): the top is
  // lower by `skim`, the chamfer narrower by as much.
  if (skim) moves.push({ setup: 0, tool: 5, points: [[-35, 12, T + 5], [-35, 12, T - skim], [60, 12, T - skim]] });
  const input: SimInput = {
    moves,
    setups: [{ orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], offset: [0, 0, 0] }],
    part: { min: [0, 0, 0], max: [24, 24, 10.4] },
    tools,
    maxVoxels: Math.round((24 * 24 * 10.4) / 0.355 ** 3),
  };
  const g = carve(input);
  const m = mesher(g, input);
  const pos: number[] = [];
  const nor: number[] = [];
  for (let id = 0; id < m.chunks; id++) {
    const ch = m.build(id, moves.length * SUB);
    ch.positions.forEach((x) => pos.push(x));
    ch.normals.forEach((x) => nor.push(x));
  }

  // Section: q = how far into the material from the wall line (horizontally), z; e = the wall's normal.
  const sect = (p: number[]) => {
    if (kind === 'straight') return { q: 12.1 - p[1], z: p[2], e: [0, 1, 0] as V, ok: p[0] > 3 && p[0] < 21 };
    const dx = p[0] - CX;
    const dy = p[1] - CY;
    const rho = Math.hypot(dx, dy) || 1e-9;
    return { q: rho - r, z: p[2], e: [-dx / rho, -dy / rho, 0] as V, ok: true };
  };
  T -= skim;
  c -= skim;
  // A pocket's or a slot's floor too, up to the inside corner where it meets the wall.
  const low = kind === 'hole' ? floor + 1 : floor;
  const segs: { name: string; a: [number, number]; b: [number, number] }[] = [
    { name: 'top', a: [c, T], b: [c + 60, T] },
    { name: 'chamfer', a: [0, T - c], b: [c, T] },
    { name: 'wall', a: [0, low], b: [0, T - c] },
    ...(kind === 'hole' ? [] : [{ name: 'floor', a: [-2, floor] as [number, number], b: [0, floor] as [number, number] }]),
  ];
  const classify = (p: number[]) => {
    const s = sect(p);
    let best = { name: '', d: Infinity };
    for (const sg of segs) {
      const vx = sg.b[0] - sg.a[0];
      const vz = sg.b[1] - sg.a[1];
      const t = Math.max(0, Math.min(1, ((s.q - sg.a[0]) * vx + (s.z - sg.a[1]) * vz) / (vx * vx + vz * vz)));
      const d = Math.hypot(s.q - sg.a[0] - t * vx, s.z - sg.a[1] - t * vz);
      if (d < best.d) best = { name: sg.name, d };
    }
    const n: V = best.name === 'top' || best.name === 'floor' ? [0, 0, 1] : best.name === 'wall' ? s.e : [s.e[0] / Math.SQRT2, s.e[1] / Math.SQRT2, Math.SQRT1_2];
    return { ...best, n, zone: s.ok && s.q > -1.5 && s.q < c + 1.5 && s.z > low - (kind === 'hole' ? 0 : 1) && s.z < T + 1 };
  };
  const deg = (a: number[], b: number[]) => (Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(a[0], a[1], a[2]) * Math.hypot(b[0], b[1], b[2]))))) * 180) / Math.PI;
  const out: Record<string, { tris: number; area: number; badShade: number; worstVertex: number }> = {};
  // How far the triangles stray from the true shape (inside them, not only at their corners): a
  // corner cut off across an edge, or a tooth along it, shows here.
  const shape = { max: 0, sum: 0, n: 0 };
  let glints = 0;
  for (let t = 0; t < pos.length / 9; t++) {
    const P = [0, 1, 2].map((k) => pos.slice(t * 9 + k * 3, t * 9 + k * 3 + 3));
    const cl = P.map(classify);
    if (cl.every((x) => x.zone)) {
      const n = nor.slice(t * 9, t * 9 + 3);
      if (c < 0.2 && n[2] > 0.5 && n[2] < 0.85) {
        const u2 = [P[1][0] - P[0][0], P[1][1] - P[0][1], P[1][2] - P[0][2]];
        const w2 = [P[2][0] - P[0][0], P[2][1] - P[0][1], P[2][2] - P[0][2]];
        glints += Math.hypot(u2[1] * w2[2] - u2[2] * w2[1], u2[2] * w2[0] - u2[0] * w2[2], u2[0] * w2[1] - u2[1] * w2[0]) / 2;
      }
      for (const [wa, wb, wc] of [[1, 1, 1], [1, 1, 0], [0, 1, 1], [1, 0, 1]]) {
        const sw = wa + wb + wc;
        const d = classify([0, 1, 2].map((a) => (P[0][a] * wa + P[1][a] * wb + P[2][a] * wc) / sw)).d;
        shape.max = Math.max(shape.max, d);
        shape.sum += d;
        shape.n++;
      }
    }
    // Triangles wholly on one surface (those across a crease belong to both).
    if (!cl.every((x) => x.zone && x.name === cl[0].name)) continue;
    const o = (out[cl[0].name] ??= { tris: 0, area: 0, badShade: 0, worstVertex: 0 });
    o.tris++;
    // By area: a sliver along an edge (all its corners on the edge) covers no pixels whatever its normal.
    const u = [P[1][0] - P[0][0], P[1][1] - P[0][1], P[1][2] - P[0][2]];
    const w = [P[2][0] - P[0][0], P[2][1] - P[0][1], P[2][2] - P[0][2]];
    const area = Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2;
    o.area += area;
    if ([0, 1, 2].some((k) => deg(nor.slice(t * 9 + k * 3, t * 9 + k * 3 + 3), cl[0].n) > 15)) o.badShade += area;
    for (const x of cl) o.worstVertex = Math.max(o.worstVertex, x.d);
  }
  return { surfaces: out, shape: { max: shape.max, mean: shape.sum / shape.n, glints } };
}

describe('chamfers and drilled holes are shaded by their true surfaces', () => {
  const cases: [string, Kind, number, number, 'plunge' | 'round', number?, number?][] = [
    ['hole Ø6, 0.5 chamfer plunged', 'hole', 3, 0.5, 'plunge'],
    ['hole Ø6, 0.25 chamfer plunged', 'hole', 3, 0.25, 'plunge'],
    ['hole Ø6, 0.5 chamfer run round', 'hole', 3, 0.5, 'round'],
    ['round pocket R6, 0.5 chamfer', 'pocket', 6, 0.5, 'round'],
    ['straight edge, 0.5 chamfer', 'straight', 0, 0.5, 'round'],
    ['hole Ø6, plain rim', 'hole', 3, 0, 'round'],
    ['hole Ø6, 0.1 deburr run round', 'hole', 3, 0.1, 'round'],
    ['hole Ø6, 0.05 spot-drill mouth', 'hole', 3, 0.05, 'plunge'],
    ['round pocket R6, 0.5 chamfer, top skimmed 0.05 after', 'pocket', 6, 0.5, 'round', 10, 0.05],
    ['hole Ø6, 0.5 chamfer, top skimmed 0.1 after', 'hole', 3, 0.5, 'round', 10, 0.1],
    // The top face anywhere between two sample layers.
    ...[9.93, 9.97, 10.04, 10.11, 10.15].flatMap((T): [string, Kind, number, number, 'plunge' | 'round', number][] => [
      [`hole Ø6, plain rim, top at ${T}`, 'hole', 3, 0, 'round', T],
      [`hole Ø6, 0.05 spot-drill mouth, top at ${T}`, 'hole', 3, 0.05, 'plunge', T],
      [`hole Ø6, 0.5 chamfer, top at ${T}`, 'hole', 3, 0.5, 'round', T],
    ]),
  ];
  for (const [name, kind, r, c, by, T, skim] of cases)
    it(name, () => {
      const { surfaces: s, shape } = scene(kind, r, c, by, T, skim);
      // The triangles stray from the true shape by less than a fifth of the sample spacing.
      expect(shape.max, 'shape').toBeLessThan(0.075);
      // A sliver narrower than half a sample (a deburr, a spot drill's rim) is drawn as a sharp
      // edge: no triangle along it glints with the sliver's slope.
      if (c < 0.355 / 2) expect(shape.glints, 'glints').toBe(0);
      for (const [surface, x] of Object.entries(s)) {
        if (c < 0.355 / 2 && surface === 'chamfer') continue;
        // No more than 2 % of a surface's area shaded more than 15° off it. A chamfer narrower
        // than the sample spacing (0.25 mm) can miss from every sample near a spot: 5 %.
        expect(x.badShade / x.area, `${surface} shading`).toBeLessThanOrEqual(c < 0.355 && surface === 'chamfer' ? 0.05 : 0.02);
        // Every corner on its surface (well within one sample spacing).
        expect(x.worstVertex, `${surface} position`).toBeLessThan(0.12);
      }
    });
});
