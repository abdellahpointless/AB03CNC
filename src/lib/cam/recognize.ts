/**
 * Step 2 of the shape engine (you, 2026-11-27: the shapes "perfectly detected every time, even if a shape intersects
 * with the other"): a STEP model's shapes from its exact faces (faces.ts), each once, named as the shop makes them, with
 * its sizes, the sides it is reached from and the faces it is made of; then a check that they explain all the material
 * between the part and its box (what they do not is named, never left silent).
 *
 * The rule when shapes meet (tools/test-part/make_feature_parts.py writes its test parts by it):
 *  - a shape is what its surfaces are: one hole however many pieces another shape cuts its wall into;
 *  - shapes at one depth that run into each other are one pocket, but a slot (two facing walls across the part) and a
 *    hole (a cylinder) stay themselves; a deeper shape starts at the floor of the shallower one it is cut from;
 *  - "from": the sides it can be reached from: a hole, the ends of its axis that open; a milled shape, the sides it is
 *    seen open from; "box": what it removes, in the model's frame; "depth": from where it starts down to its floor.
 *
 * Read only: the planner does not use it yet (step 3).
 */
import type { Vec } from '../toolpath';
import { apply, transpose, type Mat3 } from '../orient';
import { SIDES, upTurn } from './features';
import { exactFaces, type ExactFace } from './faces';
import { area, bounds, components, difference, inside, intersection, offset, rect, turnTris, union, type P2, type Region } from './geom';

export type FeatureKind = 'hole' | 'counterbore' | 'countersink' | 'pocket' | 'slot' | 'step' | 'notch' | 'window' | 'outline' | 'boss' | 'chamfer' | 'round' | 'fillet' | 'slope' | 'surface';

export type Box6 = [number, number, number, number, number, number];

export interface Feature {
  kind: FeatureKind;
  /** The sides it is reached from (the model's: Z+, X-...), sorted. */
  from: string[];
  /** The exact faces (faces.ts ids) it is made of. */
  faces: number[];
  /** What it removes (a boss: the boss itself), the model's frame: x0, y0, z0, x1, y1, z1. */
  box?: Box6;
  /** A hole, counterbore, countersink: its axis and where it lies across it (the other two axes, in order). */
  axis?: 'X' | 'Y' | 'Z';
  at?: [number, number];
  /** Ø (a hole, counterbore, boss; a countersink's at the face). */
  d?: number;
  depth?: number;
  through?: boolean;
  /** Broken open by another shape or a face (a counterbore through a face's edge: two teeth). */
  open?: boolean;
  /** A blind hole's drill point (included angle, °). */
  point?: number;
  /** A countersink's included angle; a chamfer's or a slope's off the faces it joins (°). */
  angle?: number;
  /** A pocket's inside corner radius (the smallest). */
  corner?: number;
  width?: number;
  /** A boss: how far it stands up from the floor. */
  height?: number;
  /** A chamfer's leg. */
  size?: number;
  /** A rounded edge's or a fillet's radius. */
  r?: number;
  /** Alike edges counted (a chamfer round four edges: 4). */
  count?: number;
}

export interface Recognition {
  features: Feature[];
  /** Material between the part and its box no shape explains (mm³ and where): to name, never to clean up blind. */
  unexplained: { mm3: number; box: Box6 }[];
  /** Faces no shape is made of (other than the box's own: the stock's faces). */
  unowned: number[];
}

const AX = ['X', 'Y', 'Z'] as const;
const EPS = 0.02;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cornerOf = (P: ArrayLike<number>, t: number, c: number): Vec => [P[t * 9 + c * 3], P[t * 9 + c * 3 + 1], P[t * 9 + c * 3 + 2]];
/** The principal axis a unit vector lies along (0, 1, 2), else -1. */
const axisOf = (n: Vec) => [0, 1, 2].find((k) => Math.abs(Math.abs(n[k]) - 1) < 1e-4) ?? -1;
const others = (k: number) => [0, 1, 2].filter((i) => i !== k) as [number, number];
const clean = (r: Region) => (r.length ? offset(offset(r, -0.01), 0.01) : r);
const circle = (c: P2, rad: number, n = 96): Region => [Array.from({ length: n }, (_, i) => [c[0] + rad * Math.cos((2 * Math.PI * i) / n), c[1] + rad * Math.sin((2 * Math.PI * i) / n)] as P2)];
const extentOf = (r: Region) => {
  const pts = r.flat();
  return { lo: [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))] as P2, hi: [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))] as P2 };
};

/** Inside the closed mesh (a ray's crossings, odd: inside). */
function solidAt(P: ArrayLike<number>, p: Vec): boolean {
  const d: Vec = [0.5773, 0.5774, 0.5775];
  let n = 0;
  for (let t = 0; t < P.length / 9; t++) {
    const [a, b, c] = [cornerOf(P, t, 0), cornerOf(P, t, 1), cornerOf(P, t, 2)];
    const e1: Vec = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2: Vec = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const h: Vec = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
    const det = dot(e1, h);
    if (Math.abs(det) < 1e-12) continue;
    const s: Vec = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const u = dot(s, h) / det;
    if (u < 0 || u > 1) continue;
    const q: Vec = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
    const v = dot(d, q) / det;
    if (v < 0 || u + v > 1) continue;
    if (dot(e2, q) / det > 1e-9) n++;
  }
  return n % 2 === 1;
}

/** What of the part (P, a frame's triangles) stands above height z, seen from above (but the triangles in `skip`). */
function shadow(P: ArrayLike<number>, z: number, skip?: Set<number>): Region {
  const polys: Region = [];
  for (let t = 0; t < P.length / 9; t++) {
    if (skip?.has(t)) continue;
    const v = [cornerOf(P, t, 0), cornerOf(P, t, 1), cornerOf(P, t, 2)];
    if (Math.max(v[0][2], v[1][2], v[2][2]) <= z + 1e-9) continue;
    // The triangle cut at z (what is above it).
    const out: Vec[] = [];
    for (let i = 0; i < 3; i++) {
      const [p, q] = [v[i], v[(i + 1) % 3]];
      if (p[2] > z) out.push(p);
      if (p[2] > z !== q[2] > z) {
        const k = (z - p[2]) / (q[2] - p[2]);
        out.push([p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k, z]);
      }
    }
    let a = 0;
    for (let i = 0; i < out.length; i++) a += out[i][0] * out[(i + 1) % out.length][1] - out[(i + 1) % out.length][0] * out[i][1];
    if (Math.abs(a) < 1e-8) continue;
    const loop = out.map((p) => [p[0], p[1]] as P2);
    polys.push(a > 0 ? loop : loop.reverse());
  }
  return union(polys);
}

/** A point's angle round an axis point (i, j: the two other axes). */
const angleOf = (p: Vec, i: number, j: number, c: P2) => Math.atan2(p[j] - c[1], p[i] - c[0]);
/** How far round its axis a surface goes (°): each triangle's arc, joined (a mesh's facets leave no gap of their own). */
function coverage(arcs: [number, number][]): number {
  const all: [number, number][] = [];
  for (const [a, b] of arcs) {
    if (b <= 2 * Math.PI) all.push([a, b]);
    else all.push([a, 2 * Math.PI], [0, b - 2 * Math.PI]);
  }
  all.sort((p, q) => p[0] - q[0]);
  let total = 0;
  let [s0, e0] = [-1, -1];
  for (const [a, b] of all) {
    if (a > e0 + 1e-6) {
      if (e0 > s0) total += e0 - s0;
      [s0, e0] = [a, b];
    } else e0 = Math.max(e0, b);
  }
  if (e0 > s0) total += e0 - s0;
  return (total * 180) / Math.PI;
}
/** A triangle's arc round an axis: the smallest one holding its corners' angles (from 0 to 2π, its end past it may run on). */
function arcOf(angles: number[]): [number, number] {
  const a = angles.map((v) => (v + 2 * Math.PI) % (2 * Math.PI)).sort((p, q) => p - q);
  const gaps = [a[1] - a[0], a[2] - a[1], a[0] + 2 * Math.PI - a[2]];
  const g = gaps.indexOf(Math.max(...gaps));
  return g === 0 ? [a[1], a[0] + 2 * Math.PI] : g === 1 ? [a[2], a[1] + 2 * Math.PI] : [a[0], a[2]];
}

interface Bore {
  k: number;
  c: P2;
  r: number;
  /** Along the axis (the model's coordinate). */
  lo: number;
  hi: number;
  span: number;
  faces: number[];
}
interface ConeOn {
  k: number;
  c: P2;
  half: number;
  lo: number;
  hi: number;
  rLo: number;
  rHi: number;
  face: number;
}

/** Concave cylinders along the model's axes, one per surface (its pieces joined), and the cones on them. */
function boresOf(P: ArrayLike<number>, faces: ExactFace[]): { bores: Bore[]; cones: ConeOn[] } {
  const bores: (Bore & { arcs: [number, number][] })[] = [];
  const cones: ConeOn[] = [];
  for (const f of faces) {
    const k = axisOf(f.n);
    if (k < 0 || !f.concave || (f.kind !== 'cylinder' && f.kind !== 'cone')) continue;
    const [i, j] = others(k);
    const c: P2 = [f.at[i], f.at[j]];
    const pts = f.tris.flatMap((t) => [cornerOf(P, t, 0), cornerOf(P, t, 1), cornerOf(P, t, 2)]);
    const along = pts.map((p) => p[k]);
    const [lo, hi] = [Math.min(...along), Math.max(...along)];
    if (f.kind === 'cone') {
      const rad = pts.map((p) => Math.hypot(p[i] - c[0], p[j] - c[1]));
      const atLo = pts.filter((p) => Math.abs(p[k] - lo) < 1e-3).map((p) => Math.hypot(p[i] - c[0], p[j] - c[1]));
      const atHi = pts.filter((p) => Math.abs(p[k] - hi) < 1e-3).map((p) => Math.hypot(p[i] - c[0], p[j] - c[1]));
      cones.push({ k, c, half: f.half ?? 0, lo, hi, rLo: atLo.length ? Math.max(...atLo) : Math.min(...rad), rHi: atHi.length ? Math.max(...atHi) : Math.max(...rad), face: f.id });
      continue;
    }
    const g = bores.find((b) => b.k === k && Math.hypot(b.c[0] - c[0], b.c[1] - c[1]) < 0.01 && Math.abs(b.r - f.r!) < 0.005);
    const arcs = f.tris.map((t) => arcOf([0, 1, 2].map((q) => angleOf(cornerOf(P, t, q), i, j, c))));
    if (g) {
      g.lo = Math.min(g.lo, lo);
      g.hi = Math.max(g.hi, hi);
      g.faces.push(f.id);
      g.arcs.push(...arcs);
    } else bores.push({ k, c, r: f.r!, lo, hi, span: 0, faces: [f.id], arcs });
  }
  return { bores: bores.map(({ arcs, ...b }) => ({ ...b, span: coverage(arcs) })), cones };
}

/** A milled region seen from one side, at one floor height (its own: what deeper ones do not take). */
interface Rec {
  side: string;
  R: Mat3;
  /** The part's triangles in this side's frame (its axis up). */
  T: Float32Array;
  h: number;
  top: number;
  own: Region;
  through: boolean;
  B: Region;
  kind?: FeatureKind;
  width?: number;
  faces: number[];
  /** All that is open at its floor's height (every piece there). */
  open: Region;
  /** Its side's floor heights, highest first (its bottom last). */
  levels: number[];
  /** All that is open at its floor's height in its own piece (before deeper ones took theirs). */
  K: Region;
  /** The piece at the next floor up it was cut from. */
  parent?: Rec;
  /** The piece (as seen from its side) it was split from (3). */
  orig?: Rec;
  /** The deeper piece round the island it lies over (the room over a boss is that pocket's). */
  into?: Rec;
  /** The grid cells (not the part) its room holds. */
  cells?: Int32Array;
}

/** The shapes of a STEP model: P its triangles (the model's frame), faceOf each one's exact face. */
export function recognizeFaces(P: ArrayLike<number>, faceOf: ArrayLike<number>, faces: ExactFace[] = exactFaces(P, faceOf), opts: { leaveOut?: FeatureKind[] } = {}): Recognition {
  const bb = bounds(P);
  const byId = new Map(faces.map((f) => [f.id, f]));
  const features: Feature[] = [];

  // 1. Holes: the concave cylinders along an axis, one per surface; on one axis line, a stack (counterbores over a hole,
  // countersinks and a drill point on it). A cylinder round less than 250° is no hole (a corner, a notch, a slot's end).
  const { bores, cones } = boresOf(P, faces);
  const holeFaces = new Set<number>();
  const stacks: Bore[][] = [];
  for (const b of bores.filter((x) => x.span >= 250)) {
    const s = stacks.find((st) => st[0].k === b.k && Math.hypot(st[0].c[0] - b.c[0], st[0].c[1] - b.c[1]) < 0.01);
    if (s) s.push(b);
    else stacks.push([b]);
  }
  const holeDiscs: { k: number; c: P2; r: number; lo: number; hi: number }[] = [];
  for (const st of stacks) {
    const { k, c } = st[0];
    const [i, j] = others(k);
    st.sort((p, q) => p.r - q.r);
    const inner = st[0];
    const on = cones.filter((x) => x.k === k && Math.hypot(x.c[0] - c[0], x.c[1] - c[1]) < 0.01);
    const lo = Math.min(...st.map((b) => b.lo), ...on.map((x) => x.lo));
    const hi = Math.max(...st.map((b) => b.hi), ...on.map((x) => x.hi));
    // An end opens where, just past it on the axis, there is no part (air, another shape's room).
    const pt = (v: number): Vec => {
      const p: Vec = [0, 0, 0];
      p[k] = v;
      p[i] = c[0];
      p[j] = c[1];
      return p;
    };
    const openHi = !solidAt(P, pt(hi + 0.05));
    const openLo = !solidAt(P, pt(lo - 0.05));
    const sides = [...(openHi ? [`${AX[k]}+`] : []), ...(openLo ? [`${AX[k]}-`] : [])].sort();
    // A drill point: a cone at the inner bore's closed end narrowing to nothing.
    const tip = on.find((x) => x.rLo < 0.05 * inner.r && Math.abs(x.rHi - inner.r) < 0.02 && (Math.abs(x.hi - inner.lo) < 0.02 || Math.abs(x.lo - inner.hi) < 0.02)) ?? on.find((x) => x.rHi < 0.05 * inner.r && Math.abs(x.rLo - inner.r) < 0.02);
    // Its flat bottom: a face square to the axis inside it at its closed end.
    const flat = faces.filter((f) => f.kind === 'plane' && axisOf(f.n) === k && ((!openLo && Math.abs(f.at[k] - inner.lo) < 0.01) || (!openHi && Math.abs(f.at[k] - inner.hi) < 0.01)) && f.tris.every((t) => [0, 1, 2].every((q) => Math.hypot(cornerOf(P, t, q)[i] - c[0], cornerOf(P, t, q)[j] - c[1]) <= inner.r + 0.01)));
    const own = [...inner.faces, ...(tip ? [tip.face] : []), ...flat.map((f) => f.id)];
    features.push({
      kind: 'hole',
      axis: AX[k],
      at: [r3(c[0]), r3(c[1])],
      d: r3(2 * inner.r),
      depth: r3(inner.hi - inner.lo),
      through: openHi && openLo,
      from: sides,
      faces: own,
      ...(inner.span < 355 ? { open: true } : {}),
      ...(tip ? { point: r3(2 * tip.half) } : {}),
    });
    own.forEach((x) => holeFaces.add(x));
    holeDiscs.push({ k, c, r: inner.r, lo: inner.lo, hi: inner.hi });
    // Wider bores on it: counterbores, each from the end it opens to; its floor the flat ring at its bottom.
    for (const cb of st.slice(1)) {
      const up = Math.abs(cb.hi - hi) < 0.02;
      const end = up ? cb.lo : cb.hi;
      const floor = faces.filter((f) => f.kind === 'plane' && axisOf(f.n) === k && Math.abs(f.at[k] - end) < 0.01 && f.tris.every((t) => [0, 1, 2].every((q) => Math.hypot(cornerOf(P, t, q)[i] - c[0], cornerOf(P, t, q)[j] - c[1]) <= cb.r + 0.01)));
      features.push({ kind: 'counterbore', axis: AX[k], at: [r3(c[0]), r3(c[1])], d: r3(2 * cb.r), depth: r3(cb.hi - cb.lo), from: [`${AX[k]}${up ? '+' : '-'}`], faces: [...cb.faces, ...floor.map((f) => f.id)], ...(cb.span < 355 ? { open: true } : {}) });
      [...cb.faces, ...floor.map((f) => f.id)].forEach((x) => holeFaces.add(x));
      holeDiscs.push({ k, c, r: cb.r, lo: cb.lo, hi: cb.hi });
    }
    // Countersinks: a cone widening out to an open end (not the drill point).
    for (const x of on) {
      if (x === tip) continue;
      const atHi = Math.abs(x.hi - hi) < 0.02 && openHi;
      const atLo = Math.abs(x.lo - lo) < 0.02 && openLo;
      if (!atHi && !atLo) continue;
      features.push({ kind: 'countersink', axis: AX[k], at: [r3(c[0]), r3(c[1])], d: r3(2 * (atHi ? x.rHi : x.rLo)), angle: r3(2 * x.half), from: [`${AX[k]}${atHi ? '+' : '-'}`], faces: [x.face] });
      holeFaces.add(x.face);
      holeDiscs.push({ k, c, r: Math.max(x.rHi, x.rLo), lo: x.lo, hi: x.hi });
    }
  }

  // 2. Milled shapes, from each side: at every floor height (a flat face looking that way) what is open from above
  // there (a fillet rising from that floor, round its walls or a boss's foot, does not narrow it), in pieces; each
  // piece's own room what no deeper piece takes (that one starts at this floor, but its room is its own all the way
  // up). A hole's disc is the hole's where its wall stands; the room over an island (a boss's top) is the room of the
  // deeper piece round the island.
  const grid = makeGrid(P, bb);
  const recs: Rec[] = [];
  for (const s of SIDES) {
    const R = upTurn(s.d);
    const T = turnTris(P, R);
    const fb = bounds(T);
    const [top, bot] = [fb.max[2], fb.min[2]];
    const B = rect(fb.min[0], fb.min[1], fb.max[0], fb.max[1]);
    const k = axisOf(s.d);
    const heights: number[] = [];
    for (const f of faces) {
      if (f.kind !== 'plane' || apply(R, f.n)[2] < 0.9999) continue;
      const h = apply(R, f.at)[2];
      if (h < top - 0.005 && !heights.some((x) => Math.abs(x - h) < 0.005)) heights.push(h);
    }
    heights.sort((a, b) => b - a);
    const levels = [...heights, bot];
    // The holes along this side's axis, in this frame (their discs, and how high their walls stand).
    const [i0, j0] = others(k);
    const discs = holeDiscs.filter((d) => d.k === k).map((d) => {
      const at = (v: number) => {
        const p: Vec = [0, 0, 0];
        p[k] = v;
        p[i0] = d.c[0];
        p[j0] = d.c[1];
        return apply(R, p);
      };
      const [a, b] = [at(d.lo), at(d.hi)];
      return { c: [a[0], a[1]] as P2, r: d.r, lo: Math.min(a[2], b[2]), hi: Math.max(a[2], b[2]), D: circle([a[0], a[1]], d.r) };
    });
    const allDiscs = discs.length ? union(discs.flatMap((d) => d.D)) : [];
    // The fillets in this frame: curved faces hollow toward the air, looking up, from their foot (a floor height) up.
    const fillets = faces.filter((f) => f.kind !== 'plane' && (f.kind === 'other' ? hollow(T, f) : !!f.concave) && f.tris.every((t) => normalZ(T, t) > -1e-3)).map((f) => {
      const z = f.tris.flatMap((t) => [0, 1, 2].map((c) => T[t * 9 + c * 3 + 2]));
      return { f, lo: Math.min(...z), hi: Math.max(...z) };
    });
    const pieces: { h: number; K: Region; disc: boolean; open: Region }[] = [];
    levels.forEach((h, li) => {
      const above = li === 0 ? top : levels[li - 1];
      const skip = new Set(fillets.filter((x) => Math.abs(x.lo - h) < 0.01 && x.hi <= above + 0.01).flatMap((x) => x.f.tris));
      const A = clean(difference(B, shadow(T, h + EPS, skip)));
      // A piece all inside holes' discs is those holes'.
      for (const K of components(A)) if (area(K) > 0.05) pieces.push({ h, K, disc: !!discs.length && area(difference(K, allDiscs)) < 0.05 + 0.01 * area(K), open: A });
    });
    const mine: Rec[] = [];
    for (const p of pieces) {
      if (p.disc) continue;
      const deeper = pieces.filter((q) => q.h < p.h - 0.001 && !q.disc).map((q) => q.K);
      const walled = discs.filter((d) => d.hi > p.h + 0.01 && d.lo < p.h + 0.01).flatMap((d) => d.D);
      const take = [...deeper.flat(), ...walled];
      const own = clean(take.length ? difference(p.K, union(take)) : p.K);
      if (area(own) < 0.5) continue;
      mine.push({ side: s.name, R, T, h: p.h, top, own, through: p.h === bot, B, open: p.open, levels, faces: [], K: p.K });
    }
    // Each piece's parent: the one at the next floor up whose room it was cut from.
    for (const q of mine) q.parent = mine.filter((o) => o.h > q.h + 0.001 && area(difference(q.own, o.K)) < 0.05).sort((a, b) => a.h - b.h)[0];
    for (const q of mine) {
      const p = mine.find((o) => o.h < q.h - 0.001 && area(intersection(q.own, islands(o.own))) > area(q.own) - 0.05);
      if (p) q.into = p;
    }
    recs.push(...mine);
  }

  // 3. Slots across a piece at one depth: two facing walls rising from its floor, the room between them open right
  // across the part there: a slot of its own, the rest of the piece what it was.
  const split: Rec[] = [];
  for (const r of recs) {
    let rest = r.own;
    if (!r.through && !r.into) {
      const walls = faces.filter((f) => f.kind === 'plane').map((f) => ({ f, n: apply(r.R, f.n), at: apply(r.R, f.at) })).filter((w) => Math.abs(w.n[2]) < 1e-4 && axisOf(w.n) >= 0);
      const T = r.T;
      // A wall standing on this floor: its foot at the floor's height, its top over it.
      const rises = (w: { f: ExactFace }) => {
        const z = w.f.tris.flatMap((t) => [0, 1, 2].map((q) => T[t * 9 + q * 3 + 2]));
        return z.some((v) => Math.abs(v - r.h) < 0.02) && Math.max(...z) > r.h + 0.05;
      };
      const ext = extentOf(r.B);
      for (const a of walls) {
        const ka = axisOf(a.n);
        if (a.n[ka] < 0 || !rises(a)) continue;
        for (const b of walls) {
          if (axisOf(b.n) !== ka || b.n[ka] > 0 || !rises(b) || b.at[ka] <= a.at[ka] + 0.05) continue;
          const [lo, hi] = [a.at[ka], b.at[ka]];
          const S = ka === 0 ? rect(lo, ext.lo[1] - 1, hi, ext.hi[1] + 1) : rect(ext.lo[0] - 1, lo, ext.hi[0] + 1, hi);
          const inS = intersection(S, rest);
          if (area(inS) < 1 || area(difference(rest, S)) < 0.5) continue;
          // Open right across: this floor's whole open room covers the strip over the part's width.
          if (area(intersection(S, r.open)) < area(intersection(S, r.B)) - 0.05) continue;
          split.push({ ...r, own: clean(inS), kind: 'slot', width: r3(hi - lo), faces: [], orig: r });
          rest = clean(difference(rest, S));
        }
      }
    }
    if (area(rest) >= 0.5) split.push({ ...r, own: rest, orig: r });
  }
  // A parent split in two: the piece of it next to the child.
  for (const r of split)
    if (r.parent) {
      const of = split.filter((o) => o.orig === r.parent);
      const by = (o: Rec) => area(intersection(offset(r.own, 0.1), o.own));
      r.parent = of.sort((a, b) => by(b) - by(a))[0] ?? r.parent;
    }
  for (const r of split) if (r.into) r.into = split.find((o) => o.side === r.side && o.h === r.into!.h && area(intersection(o.own, r.into!.own)) > 0.05) ?? r.into;

  // 4. What of each face each piece holds: its floor's flat faces under it, its walls along its edge and what lies in
  // its room (a floor's fillet) between its floor and the top. A face is first the piece's that holds most of it, half
  // of it or more (on a tie: the one it is the floor of, then one with a floor, then the first side's): a slot's walls
  // are its floor's piece's, not those of the same slot seen through from its end.
  const pieces = split.filter((r) => !r.into);
  const shares = new Map<number, { r: Rec; a: number; floor: boolean }[]>();
  for (const r of pieces) {
    const T = r.T;
    const inG = insideFn(offset(r.own, 0.05));
    for (const f of faces) {
      if (holeFaces.has(f.id)) continue;
      let a = 0;
      let floor = false;
      for (const t of f.tris) {
        const z = centroidZ(T, t);
        if (z < r.h - 0.01 || z > r.top + 0.01 || !inG(centroidXY(T, t))) continue;
        const up = normalZ(T, t) > 0.9999;
        if (up && Math.abs(z - r.h) >= 0.01) continue;
        if (up) floor = true;
        a += triArea(T, t);
      }
      if (a > 0) (shares.get(f.id) ?? shares.set(f.id, []).get(f.id)!).push({ r, a, floor });
    }
  }
  const better = (p: { r: Rec; a: number; floor: boolean }, q: { r: Rec; a: number; floor: boolean }) => (Math.abs(p.a - q.a) > 1e-6 * Math.max(p.a, q.a) ? q.a - p.a : Number(q.floor) - Number(p.floor) || Number(p.r.through) - Number(q.r.through));
  for (const [fid, by] of shares) {
    const best = [...by].sort(better)[0];
    if (best.a >= 0.5 * byId.get(fid)!.area) best.r.faces.push(fid);
  }

  // 5. Shapes: the pieces with faces of their own, the biggest first, the same room (its cells) seen from several sides
  // once; a piece whose room the shapes before it already hold is part of them (the room in front of a fin seen from
  // its side is part of the step round it), its faces theirs. A piece with no face is a view of other shapes (the top
  // half of a pocket seen through a step from the side): nothing of its own, unless no shape holds its room.
  for (const r of split) r.cells = prismCells(grid, r);
  for (const r of split) if (r.into) r.into.cells = Int32Array.from([...r.into.cells!, ...r.cells!]);
  type Group = { recs: Rec[]; mask: Uint8Array; count: number };
  const groups: Group[] = [];
  const held = new Uint8Array(grid.part.length);
  const bySize = (a: Rec, b: Rec) => b.cells!.length - a.cells!.length;
  const live = pieces.filter((r) => r.cells!.length);
  const order = [...live.filter((r) => r.faces.length).sort(bySize), ...live.filter((r) => !r.faces.length).sort(bySize)];
  const gone: Rec[] = [];
  for (const r of order) {
    const c = r.cells!;
    const g = groups.find((x) => {
      let common = 0;
      for (const id of c) if (x.mask[id]) common++;
      return common / (x.count + c.length - common) >= 0.9;
    });
    if (g) {
      g.recs.push(r);
      continue;
    }
    let inHeld = 0;
    for (const id of c) if (held[id]) inHeld++;
    if (inHeld >= 0.98 * c.length) {
      gone.push(r);
      continue;
    }
    const mask = new Uint8Array(grid.part.length);
    for (const id of c) [mask[id], held[id]] = [1, 1];
    groups.push({ recs: [r], mask, count: c.length });
  }
  // A shape all of whose room the others hold, together, is part of them too (the room in front of a foot, its end in
  // the step round the foot and the rest in a notch over it): the smallest first.
  const cover = new Uint16Array(grid.part.length);
  for (const g of groups) for (let id = 0; id < cover.length; id++) cover[id] += g.mask[id];
  for (const g of [...groups].sort((a, b) => a.count - b.count)) {
    let inOthers = 0;
    for (let id = 0; id < cover.length; id++) if (g.mask[id] && cover[id] > 1) inOthers++;
    if (inOthers < 0.98 * g.count) continue;
    for (let id = 0; id < cover.length; id++) cover[id] -= g.mask[id];
    groups.splice(groups.indexOf(g), 1);
    gone.push(...g.recs);
  }
  // The faces of a piece that is part of other shapes: the shape's that holds most of it.
  const groupOf = new Map<Rec, Group>();
  for (const g of groups) for (const r of g.recs) groupOf.set(r, g);
  for (const r of gone)
    for (const fid of r.faces.splice(0)) {
      const best = (shares.get(fid) ?? []).filter((x) => groupOf.has(x.r)).sort(better)[0];
      if (best) best.r.faces.push(fid);
    }
  // From every side whose pieces' rooms hold all of it (a cell or two, or one in 200, aside: the grid's own).
  const seenFrom = SIDES.map((s) => {
    const m = new Uint8Array(grid.part.length);
    for (const r of split) if (r.side === s.name) for (const id of r.cells!) m[id] = 1;
    return [s.name, m] as const;
  });
  const cellsOf = new Map<Feature, Uint8Array>();
  const DBG = (globalThis as { __recDebug?: (s: string) => void }).__recDebug;
  if (DBG) for (const r of split) DBG(`${r.side} h=${r3(r.h)} thr=${r.through} into=${!!r.into} area=${r3(area(r.own))} ext=${JSON.stringify(extentOf(r.own))} faces=${r.faces} cells=${r.cells!.length} parent=${r.parent ? r3(r.parent.h) : '-'} grp=${groups.findIndex((g) => g.recs.includes(r))} gone=${gone.includes(r)}`);
  const rank: FeatureKind[] = ['pocket', 'slot', 'notch', 'step', 'window', 'outline'];
  for (const g of groups) {
    // Named from the side it has a floor on (a pocket before a slot before a step...).
    const named = g.recs.map((r) => ({ r, kind: r.kind ?? kindOf(r) }));
    const { r, kind: k0 } = named.filter((x) => !x.r.through && x.r.faces.length).sort((a, b) => rank.indexOf(a.kind) - rank.indexOf(b.kind))[0] ?? named.filter((x) => x.r.faces.length)[0] ?? named[0];
    const fs = [...new Set(g.recs.flatMap((x) => x.faces))].sort((a, b) => a - b);
    const gf = fs.map((id) => byId.get(id)!);
    // Made only of an edge's faces (a chamfer's, a round's): that edge's shape (6), not a milled one.
    const narrowTilt = (f: ExactFace) => f.kind === 'plane' && axisOf(f.n) < 0 && narrow(P, f);
    if (gf.length && gf.every((f) => narrowTilt(f) || f.kind === 'cone' || (f.kind === 'cylinder' && !f.concave))) {
      // Its room past the edge (beside a tab the edge's chamfer runs out at) is the shape's it was cut from.
      for (const x of g.recs) {
        let p = x.parent;
        while (p && !groupOf.has(p)) p = p.parent;
        if (p) for (let id = 0; id < g.mask.length; id++) if (g.mask[id]) groupOf.get(p)!.mask[id] = 1;
      }
      continue;
    }
    const from = new Set(g.recs.map((x) => x.side));
    for (const [side, m] of seenFrom) {
      let missing = 0;
      for (let id = 0; id < m.length; id++) if (g.mask[id] && !m[id]) missing++;
      if (missing <= Math.max(2, 0.005 * g.count)) from.add(side);
    }
    let kind = k0;
    // Walled only by tilted flat faces: a slope, whichever side it is seen from.
    let angle: number | undefined;
    if (gf.length && gf.every((f) => f.kind === 'plane' && axisOf(f.n) < 0)) {
      const f = gf.slice().sort((a, b) => b.area - a.area)[0];
      const ka = [0, 1, 2].sort((a, b) => Math.abs(f.n[b]) - Math.abs(f.n[a]))[0];
      kind = 'slope';
      angle = r3((Math.acos(Math.min(1, Math.abs(f.n[ka]))) * 180) / Math.PI);
      from.add(`${AX[ka]}${f.n[ka] > 0 ? '+' : '-'}`);
    }
    const T = r.T;
    const mineFaces = r.faces.map((id) => byId.get(id)!);
    const e = extentOf(r.own);
    const Rt = transpose(r.R);
    // Through: along its side's axis as far as its walls go; else from its floor up to the top of the walls round it.
    const zs = gf.flatMap((f) => f.tris.flatMap((t) => [0, 1, 2].map((c) => T[t * 9 + c * 3 + 2])));
    const [z0, z1] = r.through ? (zs.length ? [Math.max(r.h, Math.min(...zs)), Math.min(r.top, Math.max(...zs))] : [r.h, r.top]) : [r.h, wallTop(r)];
    const corner = mineFaces.filter((f) => f.kind === 'cylinder' && f.concave && axisOf(apply(r.R, f.n)) === 2 && (f.span ?? 360) <= 181).map((f) => f.r!);
    // A notch open at one end between two facing walls, as long as it is wide: a slot.
    let width = kind === 'slot' ? (r.width ?? slotWidth(r, mineFaces)) : undefined;
    if (kind === 'notch' && !r.through) {
      const t = touches(r);
      const along = t.xlo || t.xhi ? 0 : 1;
      const w = slotWidth(r, mineFaces, 1 - along);
      if (w !== undefined && e.hi[along] - e.lo[along] >= w - 0.01) [kind, width] = ['slot', w];
    }
    const feat: Feature = {
      kind,
      from: [...from].sort(),
      faces: fs,
      box: snap(boxOf(Rt, [e.lo[0], e.lo[1], z0], [e.hi[0], e.hi[1], z1]), gf, P),
      ...(kind === 'slope' ? { angle } : r.through ? { through: true } : { depth: r3(z1 - r.h) }),
      ...(corner.length && kind !== 'slope' ? { corner: r3(Math.min(...corner)) } : {}),
      ...(width !== undefined ? { width } : {}),
    };
    features.push(feat);
    cellsOf.set(feat, g.mask);
    // Bosses: the part standing up from its floor, by itself (inside it, or a tab out of a wall flush with the top:
    // less than half its edge on the part's outline), from the floor to its own top.
    const near = offset(r.own, 0.05);
    for (const isl of components(clean(difference(r.B, r.open)))) {
      if (area(isl) > 0.5 * area(r.B) || area(intersection(offset(isl, 0.05), near)) < 0.01) continue;
      const per = isl.reduce((t, l) => t + l.reduce((u, p, i) => u + Math.hypot(l[(i + 1) % l.length][0] - p[0], l[(i + 1) % l.length][1] - p[1]), 0), 0);
      if (per - perimeterOff(isl, r.B) >= 0.5 * per) continue;
      const inI = insideFn(isl);
      const inI5 = insideFn(offset(isl, 0.05));
      const topI = Math.max(...faces.filter((f) => f.kind === 'plane' && apply(r.R, f.n)[2] > 0.9999).filter((f) => f.tris.some((t) => inI(centroidXY(T, t)))).map((f) => apply(r.R, f.at)[2]), r.h);
      const ie = extentOf(isl);
      // Its faces (not its edges' chamfers: those are chamfers of their own).
      const bossFaces = faces.filter((f) => !holeFaces.has(f.id) && f.kind !== 'cone' && !(f.kind === 'plane' && axisOf(f.n) < 0 && narrow(P, f)) && f.tris.some((t) => inI5(centroidXY(T, t)) && centroidZ(T, t) > r.h + 0.01 && centroidZ(T, t) <= topI + 0.01)).map((f) => f.id);
      // Round all the way (its wall's pieces on one axis together): its Ø.
      const outs = bossFaces.map((id) => byId.get(id)!).filter((f) => f.kind === 'cylinder' && !f.concave);
      const cyl = outs.find((f) => coverage(outs.filter((o) => Math.abs(o.r! - f.r!) < 0.005 && dist2(o) === dist2(f)).flatMap((o) => arcsOf(P, o))) >= 355);
      features.push({ kind: 'boss', from: [r.side], faces: bossFaces, box: snap(boxOf(Rt, [ie.lo[0], ie.lo[1], r.h], [ie.hi[0], ie.hi[1], topI]), bossFaces.map((id) => byId.get(id)!), P), height: r3(topI - r.h), ...(cyl ? { d: r3(2 * cyl.r!) } : {}) });
    }
  }

  // 6. What is left: the edges' chamfers, rounds and fillets, slopes, 3D surfaces; the box's own faces are the stock's.
  const owned = new Set(features.flatMap((f) => f.faces));
  const stock = (f: ExactFace) => f.kind === 'plane' && axisOf(f.n) >= 0 && Math.abs(f.at[axisOf(f.n)] - (f.n[axisOf(f.n)] > 0 ? bb.max : bb.min)[axisOf(f.n)]) < 0.01;
  const edges: { kind: FeatureKind; key: string; f: ExactFace; size?: number; angle?: number; r?: number; from?: string[] }[] = [];
  // How far from each edge face the material it took off reaches (-1: a slope's, all that lies over it).
  const reach = new Map<number, number>();
  const unowned: number[] = [];
  for (const f of faces) {
    // A sliver (a cone's tip closed by a face a micron across) removes nothing.
    if (owned.has(f.id) || stock(f) || f.area < 1e-4) continue;
    const pts = f.tris.flatMap((t) => [cornerOf(P, t, 0), cornerOf(P, t, 1), cornerOf(P, t, 2)]);
    if (f.kind === 'plane') {
      // Off the axis nearest its normal: its angle; across: how far it runs and drops.
      const k = [0, 1, 2].sort((a, b) => Math.abs(f.n[b]) - Math.abs(f.n[a]))[0];
      if (axisOf(f.n) >= 0) {
        unowned.push(f.id);
        continue;
      }
      const tilt = (Math.acos(Math.min(1, Math.abs(f.n[k]))) * 180) / Math.PI;
      const { drop, run } = legs(P, f);
      // A chamfer is reached from every side its face looks toward (a 45° one: both); a slope from the one it looks to most.
      const toward = [0, 1, 2].filter((a) => Math.abs(f.n[a]) >= 0.25).map((a) => `${AX[a]}${f.n[a] > 0 ? '+' : '-'}`);
      if (narrow(P, f)) edges.push({ kind: 'chamfer', key: planeKey(f), f, size: r3(Math.max(drop, run)), angle: r3(tilt), from: toward });
      else edges.push({ kind: 'slope', key: planeKey(f), f, angle: r3(tilt), from: [`${AX[k]}${f.n[k] > 0 ? '+' : '-'}`] });
      reach.set(f.id, narrow(P, f) ? (drop * run) / Math.hypot(drop, run) : -1);
    } else if (f.kind === 'cylinder') {
      edges.push({ kind: f.concave ? 'fillet' : 'round', key: `${f.n.map((v) => r3(Math.abs(v))).join(',')}|${r3(f.r!)}|${dist2(f)}`, f, r: r3(f.r!), from: lookTo(P, f) });
      // A round takes off what lies between it and the sharp edge it replaces (r (√2 - 1) out); a fillet adds.
      reach.set(f.id, f.concave ? 0 : f.r! * (Math.SQRT2 - 1));
    } else if (f.kind === 'cone') {
      const size = (f.hi ?? 0) - (f.lo ?? 0);
      edges.push({ kind: 'chamfer', key: `${f.id}`, f, angle: r3(f.half ?? 0), size: r3(size), from: lookTo(P, f) });
      reach.set(f.id, size * Math.sin(((f.half ?? 45) * Math.PI) / 180));
    } else {
      edges.push({ kind: 'surface', key: `${f.id}`, f, from: lookTo(P, f) });
      reach.set(f.id, Math.max(...[0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k])) - Math.min(...pts.map((p) => p[k])))));
    }
  }
  // Alike edges once, counted by their surfaces (a chamfer a hole cuts in two is one edge).
  const byKind = new Map<string, { e: (typeof edges)[number]; surfaces: Set<string>; faces: number[]; from: Set<string> }>();
  for (const e of edges) {
    // A chamfer, a round, a fillet: alike ones together (by size), each surface once; a slope or a surface: by itself.
    const group = e.kind === 'chamfer' ? `${e.kind}|${e.size}|${e.angle}` : e.kind === 'round' || e.kind === 'fillet' ? `${e.kind}|${e.r}` : `${e.kind}|${e.key}`;
    const g = byKind.get(group) ?? byKind.set(group, { e, surfaces: new Set(), faces: [], from: new Set() }).get(group)!;
    g.surfaces.add(e.key);
    g.faces.push(e.f.id);
    for (const x of e.from ?? []) g.from.add(x);
  }
  for (const { e, surfaces, faces: fs, from } of byKind.values())
    features.push({
      kind: e.kind,
      from: [...from].sort(),
      faces: fs.sort((a, b) => a - b),
      ...(e.size !== undefined ? { size: e.size } : {}),
      ...(e.angle !== undefined ? { angle: e.angle } : {}),
      ...(e.r !== undefined ? { r: e.r } : {}),
      ...(e.kind === 'chamfer' || e.kind === 'round' || e.kind === 'fillet' ? { count: surfaces.size } : {}),
    });

  // 7. The check: the material between the part and its box, every bit of it explained by a shape (a test leaves some
  // out to see the check name them).
  const kept = features.filter((f) => !opts.leaveOut?.includes(f.kind));
  const unexplained = check(P, grid, kept, cellsOf, byId, reach);
  return { features: kept, unexplained, unowned };
}

const triArea = (T: ArrayLike<number>, t: number) => {
  const [p, q, w] = [0, 1, 2].map((c) => cornerOf(T, t, c));
  const u: Vec = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const v: Vec = [w[0] - p[0], w[1] - p[1], w[2] - p[2]];
  return Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
};
const centroidXY = (T: ArrayLike<number>, t: number): P2 => [(T[t * 9] + T[t * 9 + 3] + T[t * 9 + 6]) / 3, (T[t * 9 + 1] + T[t * 9 + 4] + T[t * 9 + 7]) / 3];
const centroidZ = (T: ArrayLike<number>, t: number) => (T[t * 9 + 2] + T[t * 9 + 5] + T[t * 9 + 8]) / 3;
const signedArea = (l: P2[]) => l.reduce((a, p, i) => a + p[0] * l[(i + 1) % l.length][1] - l[(i + 1) % l.length][0] * p[1], 0) / 2;
const planeKey = (f: ExactFace) => `${f.n.map((v) => r3(v)).join(',')}|${r3(dot(f.n, f.at))}`;
/** A cylinder's axis line, as a key (where it crosses the plane square to it through the origin). */
const dist2 = (f: ExactFace) => {
  const t = dot(f.at, f.n);
  return [0, 1, 2].map((k) => r3(f.at[k] - t * f.n[k])).join(',');
};

/** A frame's box (lo, hi) in the model's frame (Rt: back). */
function boxOf(Rt: Mat3, lo: Vec, hi: Vec): Box6 {
  const pts = [0, 1, 2, 3, 4, 5, 6, 7].map((b) => apply(Rt, [b & 1 ? hi[0] : lo[0], b & 2 ? hi[1] : lo[1], b & 4 ? hi[2] : lo[2]]));
  return [0, 1, 2, 0, 1, 2].map((k, i) => (i < 3 ? Math.min(...pts.map((p) => p[k])) : Math.max(...pts.map((p) => p[k])))) as Box6;
}

/**
 * A box's sides put on the exact faces near them (a wall's plane, a cylinder's centre ± radius, a tilted face's ends):
 * micron sizes.
 */
function snap(b: Box6, fs: ExactFace[], P: ArrayLike<number>): Box6 {
  const exact: number[][] = [[], [], []];
  for (const f of fs) {
    if (f.kind === 'plane' && axisOf(f.n) >= 0) exact[axisOf(f.n)].push(f.at[axisOf(f.n)]);
    else if (f.kind === 'cylinder' && axisOf(f.n) >= 0) for (const k of others(axisOf(f.n))) exact[k].push(f.at[k] - f.r!, f.at[k] + f.r!);
    else if (f.kind === 'plane')
      for (let k = 0; k < 3; k++) {
        const v = f.tris.flatMap((t) => [0, 1, 2].map((c) => P[t * 9 + c * 3 + k]));
        exact[k].push(Math.min(...v), Math.max(...v));
      }
  }
  return b.map((v, i) => {
    const near = exact[i % 3].filter((x) => Math.abs(x - v) < 0.06).sort((p, q) => Math.abs(p - v) - Math.abs(q - v))[0];
    return r3(near ?? v);
  }) as Box6;
}

/** The part's sides (in its frame) a piece reaches. */
function touches(r: Rec) {
  const e = extentOf(r.B);
  const o = extentOf(r.own);
  return { xlo: o.lo[0] < e.lo[0] + 0.02, xhi: o.hi[0] > e.hi[0] - 0.02, ylo: o.lo[1] < e.lo[1] + 0.02, yhi: o.hi[1] > e.hi[1] - 0.02 };
}

function kindOf(r: Rec): FeatureKind {
  const e = extentOf(r.B);
  const o = extentOf(r.own);
  const touch = touches(r);
  const n = Object.values(touch).filter(Boolean).length;
  if (!n) return r.through ? 'window' : 'pocket';
  const full = touch.xlo || touch.xhi ? o.hi[1] - o.lo[1] > e.hi[1] - e.lo[1] - 0.05 : o.hi[0] - o.lo[0] > e.hi[0] - e.lo[0] - 0.05;
  // Through: cut into one side of the outline, a notch; else the outline's own.
  if (r.through) return n === 1 && !full ? 'notch' : 'outline';
  // Open on three sides or round a corner: a step; right across, open at its two ends: a slot; open on one side: a
  // step along all of it, else a notch.
  if (n >= 3) return 'step';
  if (n === 2) return (touch.xlo && touch.xhi) || (touch.ylo && touch.yhi) ? 'slot' : 'step';
  return full ? 'step' : 'notch';
}

/** Inside a region, fast (its loops read even-odd: outlines and their holes). */
function insideFn(r: Region): (p: P2) => boolean {
  const loops = r.map((l) => Float64Array.from(l.flat()));
  return ([x, y]) => {
    let odd = false;
    for (const L of loops)
      for (let a = 0, b = L.length - 2; a < L.length; b = a, a += 2) {
        const [ya, yb] = [L[a + 1], L[b + 1]];
        if (ya > y !== yb > y && x < ((L[b] - L[a]) * (y - ya)) / (yb - ya) + L[a]) odd = !odd;
      }
    return odd;
  };
}
/** The holes in a region, as regions of their own (where the part stands up inside it). */
const islands = (r: Region): Region => r.filter((l) => signedArea(l) < 0).map((l) => l.slice().reverse());
/** A triangle's normal's Z (unit). */
function normalZ(T: ArrayLike<number>, t: number): number {
  const [p, q, w] = [0, 1, 2].map((c) => cornerOf(T, t, c));
  const u: Vec = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const v: Vec = [w[0] - p[0], w[1] - p[1], w[2] - p[2]];
  const c: Vec = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(...c);
  return l ? c[2] / l : 0;
}
/** A slot's width: the nearest two of its walls that face each other. */
function slotWidth(r: Rec, fs: ExactFace[], across?: number): number | undefined {
  const w = fs.filter((f) => f.kind === 'plane').map((f) => ({ n: apply(r.R, f.n), at: apply(r.R, f.at) })).filter((x) => Math.abs(x.n[2]) < 1e-4 && axisOf(x.n) >= 0 && (across === undefined || axisOf(x.n) === across));
  let best: number | undefined;
  for (const a of w)
    for (const b of w) {
      const k = axisOf(a.n);
      if (axisOf(b.n) !== k || a.n[k] < 0 || b.n[k] > 0) continue;
      const gap = b.at[k] - a.at[k];
      if (gap > 0.05 && (best === undefined || gap < best)) best = gap;
    }
  return best === undefined ? undefined : r3(best);
}

/** The box between the part and its bounds in cells: the part's own marked (column by column, its faces' crossings). */
interface Grid {
  bb: { min: Vec; max: Vec };
  n: number[];
  st: number[];
  part: Uint8Array;
}
function makeGrid(P: ArrayLike<number>, bb: { min: Vec; max: Vec }): Grid {
  const size = [0, 1, 2].map((k) => bb.max[k] - bb.min[k]);
  const step = Math.max(0.25, Math.cbrt((size[0] * size[1] * size[2]) / 1.5e6));
  const n = size.map((s) => Math.max(1, Math.round(s / step)));
  const st = size.map((s, k) => s / n[k]);
  const part = new Uint8Array(n[0] * n[1] * n[2]);
  const cols: number[][] = Array.from({ length: n[0] * n[1] }, () => []);
  for (let t = 0; t < P.length / 9; t++) {
    const [a, b, c] = [cornerOf(P, t, 0), cornerOf(P, t, 1), cornerOf(P, t, 2)];
    const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(den) < 1e-12) continue;
    // The columns it may cover, one more each way (a column on its edge must not fall out to a rounding error).
    const i0 = Math.max(0, Math.ceil((Math.min(a[0], b[0], c[0]) - bb.min[0]) / st[0] - 0.5) - 1);
    const i1 = Math.min(n[0] - 1, Math.floor((Math.max(a[0], b[0], c[0]) - bb.min[0]) / st[0] - 0.5) + 1);
    const j0 = Math.max(0, Math.ceil((Math.min(a[1], b[1], c[1]) - bb.min[1]) / st[1] - 0.5) - 1);
    const j1 = Math.min(n[1] - 1, Math.floor((Math.max(a[1], b[1], c[1]) - bb.min[1]) / st[1] - 0.5) + 1);
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        // A hair off the cell's middle, more than a float's error (a column down a shared edge counts it twice).
        const [x, y] = [bb.min[0] + (i + 0.5) * st[0] + 1.13e-4, bb.min[1] + (j + 0.5) * st[1] + 1.71e-4];
        const u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / den;
        const v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / den;
        if (u >= 0 && v >= 0 && u + v <= 1) cols[j * n[0] + i].push(u * a[2] + v * b[2] + (1 - u - v) * c[2]);
      }
  }
  cols.forEach((h, col) => {
    h.sort((p, q) => p - q);
    for (let m = 0; m + 1 < h.length; m += 2)
      for (let k = 0; k < n[2]; k++) {
        const z = bb.min[2] + (k + 0.5) * st[2];
        if (z > h[m] && z < h[m + 1]) part[k * n[0] * n[1] + col] = 1;
      }
  });
  return { bb, n, st, part };
}
const cellAt = (g: Grid, i: number, j: number, k: number): Vec => [g.bb.min[0] + (i + 0.5) * g.st[0], g.bb.min[1] + (j + 0.5) * g.st[1], g.bb.min[2] + (k + 0.5) * g.st[2]];

/** The empty cells a piece's room holds: over its own outline, from its floor to its side's top. */
function prismCells(g: Grid, r: Rec): Int32Array {
  const k = axisOf(apply(transpose(r.R), [0, 0, 1]));
  const [a, b] = others(k);
  const e = extentOf(r.own);
  const bx = boxOf(transpose(r.R), [e.lo[0], e.lo[1], r.h], [e.hi[0], e.hi[1], r.top]);
  const lim = [0, 1, 2].map((q) => [Math.max(0, Math.floor((bx[q] - g.bb.min[q]) / g.st[q] - 0.5)), Math.min(g.n[q] - 1, Math.ceil((bx[q + 3] - g.bb.min[q]) / g.st[q] - 0.5))]);
  const inOwn = insideFn(r.own);
  const out: number[] = [];
  const ijk = [0, 0, 0];
  for (let u = lim[a][0]; u <= lim[a][1]; u++)
    for (let v = lim[b][0]; v <= lim[b][1]; v++) {
      ijk[a] = u;
      ijk[b] = v;
      ijk[k] = 0;
      const q = apply(r.R, cellAt(g, ijk[0], ijk[1], ijk[2]));
      if (!inOwn([q[0], q[1]])) continue;
      for (let w = lim[k][0]; w <= lim[k][1]; w++) {
        ijk[k] = w;
        const p = cellAt(g, ijk[0], ijk[1], ijk[2]);
        const z = apply(r.R, p)[2];
        const id = (ijk[2] * g.n[1] + ijk[1]) * g.n[0] + ijk[0];
        if (z >= r.h - 1e-6 && z <= r.top + 1e-6 && !g.part[id]) out.push(id);
      }
    }
  return Int32Array.from(out);
}

/** The material between the part and its box that no shape removes: cells, joined; what is over 1 mm³. */
function check(P: ArrayLike<number>, g: Grid, features: Feature[], cellsOf: Map<Feature, Uint8Array>, byId: Map<number, ExactFace>, reach: Map<number, number>): { mm3: number; box: Box6 }[] {
  const { bb, n, st, part } = g;
  const idx = (i: number, j: number, k: number) => (k * n[1] + j) * n[0] + i;
  const done = new Uint8Array(part.length);
  // Milled shapes: their rooms (from every side they are seen from).
  for (const f of features) {
    const m = cellsOf.get(f);
    if (m) for (let id = 0; id < m.length; id++) if (m[id]) done[id] = 1;
  }
  // Holes, counterbores, countersinks: round their axis over their length; the edges' shapes: near their face.
  for (const f of features) {
    const fs = f.faces.map((id) => byId.get(id)!).filter(Boolean);
    if (f.kind === 'hole' || f.kind === 'counterbore' || f.kind === 'countersink') {
      const k = AX.indexOf(f.axis!);
      const [i2, j2] = others(k);
      for (const h of fs) {
        const pts = h.tris.flatMap((t) => [cornerOf(P, t, 0), cornerOf(P, t, 1), cornerOf(P, t, 2)]);
        const [lo, hi] = [Math.min(...pts.map((p) => p[k])), Math.max(...pts.map((p) => p[k]))];
        const rad = Math.max(...pts.map((p) => Math.hypot(p[i2] - f.at![0], p[j2] - f.at![1])));
        mark(done, part, n, st, bb, (p) => p[k] >= lo - 1e-6 && p[k] <= hi + 1e-6 && Math.hypot(p[i2] - f.at![0], p[j2] - f.at![1]) <= rad + 1e-6, [k, lo, hi], [i2, f.at![0] - rad, f.at![0] + rad], [j2, f.at![1] - rad, f.at![1] + rad]);
      }
    } else if (!cellsOf.has(f)) {
      for (const h of fs) {
        const out = reach.get(h.id) ?? 0;
        if (out === 0) continue;
        const L = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]);
        const near = out + Math.max(...st);
        for (const t of h.tris) {
          const tri = [0, 1, 2].map((c) => cornerOf(P, t, c));
          // A slope: all that lies over it, along its normal; else what lies near it.
          const ends = out < 0 ? [...tri, ...tri.map((p) => [p[0] + L * h.n[0], p[1] + L * h.n[1], p[2] + L * h.n[2]] as Vec)] : tri;
          const pad = out < 0 ? 0 : near;
          const lo = [0, 1, 2].map((k) => Math.min(...ends.map((p) => p[k])) - pad);
          const hi = [0, 1, 2].map((k) => Math.max(...ends.map((p) => p[k])) + pad);
          mark(done, part, n, st, bb, out < 0 ? (p) => overTri(p, tri, h.n) : (p) => distToTri(p, tri) <= near, [0, lo[0], hi[0]], [1, lo[1], hi[1]], [2, lo[2], hi[2]]);
        }
      }
    }
  }
  // What is left, joined (6 neighbours); the grid's own fringe along the part (cells touching it) left out.
  const left = new Uint8Array(part.length);
  for (let id = 0; id < part.length; id++) if (!part[id] && !done[id]) left[id] = 1;
  const seen = new Uint8Array(part.length);
  const out: { mm3: number; box: Box6 }[] = [];
  const nb = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  for (let id0 = 0; id0 < left.length; id0++) {
    if (!left[id0] || seen[id0]) continue;
    const stack = [id0];
    seen[id0] = 1;
    let count = 0;
    let deep = 0;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    while (stack.length) {
      const id = stack.pop()!;
      const i = id % n[0];
      const j = Math.floor(id / n[0]) % n[1];
      const k = Math.floor(id / (n[0] * n[1]));
      count++;
      const p = cellAt(g, i, j, k);
      for (let a = 0; a < 3; a++) [lo[a], hi[a]] = [Math.min(lo[a], p[a]), Math.max(hi[a], p[a])];
      let fringe = false;
      for (const [di, dj, dk] of nb) {
        const [a, b, c] = [i + di, j + dj, k + dk];
        if (a < 0 || b < 0 || c < 0 || a >= n[0] || b >= n[1] || c >= n[2]) continue;
        const o = idx(a, b, c);
        if (part[o]) fringe = true;
        if (left[o] && !seen[o]) {
          seen[o] = 1;
          stack.push(o);
        }
      }
      if (!fringe) deep++;
    }
    const mm3 = count * st[0] * st[1] * st[2];
    if (deep > 0 && mm3 >= 1) out.push({ mm3: r3(mm3), box: [lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]].map(r3) as Box6 });
  }
  return out;
}

function mark(done: Uint8Array, part: Uint8Array, n: number[], st: number[], bb: { min: Vec; max: Vec }, inSide: (p: Vec) => boolean, ...ranges: [number, number, number][]) {
  const lim: [number, number][] = [
    [0, n[0] - 1],
    [0, n[1] - 1],
    [0, n[2] - 1],
  ];
  for (const [k, lo, hi] of ranges) lim[k] = [Math.max(lim[k][0], Math.floor((lo - bb.min[k]) / st[k] - 0.5)), Math.min(lim[k][1], Math.ceil((hi - bb.min[k]) / st[k] - 0.5))];
  for (let k = lim[2][0]; k <= lim[2][1]; k++)
    for (let j = lim[1][0]; j <= lim[1][1]; j++)
      for (let i = lim[0][0]; i <= lim[0][1]; i++) {
        const id = (k * n[1] + j) * n[0] + i;
        if (part[id] || done[id]) continue;
        if (inSide([bb.min[0] + (i + 0.5) * st[0], bb.min[1] + (j + 0.5) * st[1], bb.min[2] + (k + 0.5) * st[2]])) done[id] = 1;
      }
}

/** Distance from a point to a triangle. */
function distToTri(p: Vec, [a, b, c]: Vec[]): number {
  const sub = (u: Vec, v: Vec): Vec => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return Math.hypot(...ap);
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return Math.hypot(...bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return Math.hypot(...sub(p, [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]]));
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return Math.hypot(...cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return Math.hypot(...sub(p, [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]]));
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return Math.hypot(...sub(p, [b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])]));
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return Math.hypot(...sub(p, [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]));
}

/** Over a triangle along its normal n (its projection on the triangle's plane inside it, on n's side). */
function overTri(p: Vec, [a, b, c]: Vec[], n: Vec): boolean {
  const s = dot(n, [p[0] - a[0], p[1] - a[1], p[2] - a[2]]);
  if (s <= 0) return false;
  const q: Vec = [p[0] - s * n[0], p[1] - s * n[1], p[2] - s * n[2]];
  const v0: Vec = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v1: Vec = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const v2: Vec = [q[0] - a[0], q[1] - a[1], q[2] - a[2]];
  const [d00, d01, d11, d20, d21] = [dot(v0, v0), dot(v0, v1), dot(v1, v1), dot(v2, v0), dot(v2, v1)];
  const den = d00 * d11 - d01 * d01;
  if (Math.abs(den) < 1e-12) return false;
  const v = (d11 * d20 - d01 * d21) / den;
  const w = (d00 * d21 - d01 * d20) / den;
  return v >= -1e-6 && w >= -1e-6 && v + w <= 1 + 1e-6;
}

/** A tilted flat face's two legs: how far it drops along the axis nearest its normal, and runs across that. */
function legs(P: ArrayLike<number>, f: ExactFace): { drop: number; run: number } {
  const k = [0, 1, 2].sort((a, b) => Math.abs(f.n[b]) - Math.abs(f.n[a]))[0];
  const pts = f.tris.flatMap((t) => [cornerOf(P, t, 0), cornerOf(P, t, 1), cornerOf(P, t, 2)]);
  const h = Math.hypot(...([0, 1, 2].map((a) => (a === k ? 0 : f.n[a])) as Vec));
  const g: Vec = [0, 1, 2].map((a) => (a === k ? 0 : f.n[a] / h)) as Vec;
  return { drop: Math.max(...pts.map((p) => p[k])) - Math.min(...pts.map((p) => p[k])), run: Math.max(...pts.map((p) => dot(p, g))) - Math.min(...pts.map((p) => dot(p, g))) };
}
/** A chamfer's face, not a slope's: both legs short. */
function narrow(P: ArrayLike<number>, f: ExactFace): boolean {
  const { drop, run } = legs(P, f);
  return Math.min(drop, run) <= 3 && Math.max(drop, run) <= 4.5;
}
/** The sides a face looks toward (its triangles' normals a quarter or more that way). */
function lookTo(P: ArrayLike<number>, f: ExactFace): string[] {
  const out = new Set<string>();
  for (const t of f.tris) {
    const [p, q, w] = [0, 1, 2].map((c) => cornerOf(P, t, c));
    const u: Vec = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const v: Vec = [w[0] - p[0], w[1] - p[1], w[2] - p[2]];
    const c: Vec = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(...c);
    if (l) for (let a = 0; a < 3; a++) if (Math.abs(c[a] / l) >= 0.25) out.add(`${AX[a]}${c[a] > 0 ? '+' : '-'}`);
  }
  return [...out];
}

/** The part's triangles by where they lie seen from above (2 mm squares), for one frame. */
const bins = new WeakMap<ArrayLike<number>, { x0: number; y0: number; nx: number; ny: number; cell: number[][] }>();
/** The top of the part over (x, y) in a frame (its triangles T): -Infinity where there is none. */
function heightAt(T: ArrayLike<number>, x: number, y: number): number {
  let b = bins.get(T);
  if (!b) {
    const bb = bounds(T);
    const S = 2;
    const [nx, ny] = [Math.max(1, Math.ceil((bb.max[0] - bb.min[0]) / S)), Math.max(1, Math.ceil((bb.max[1] - bb.min[1]) / S))];
    const cell: number[][] = Array.from({ length: nx * ny }, () => []);
    for (let t = 0; t < T.length / 9; t++) {
      const xs = [T[t * 9], T[t * 9 + 3], T[t * 9 + 6]];
      const ys = [T[t * 9 + 1], T[t * 9 + 4], T[t * 9 + 7]];
      const [i0, i1] = [Math.max(0, Math.floor((Math.min(...xs) - bb.min[0]) / S)), Math.min(nx - 1, Math.floor((Math.max(...xs) - bb.min[0]) / S))];
      const [j0, j1] = [Math.max(0, Math.floor((Math.min(...ys) - bb.min[1]) / S)), Math.min(ny - 1, Math.floor((Math.max(...ys) - bb.min[1]) / S))];
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) cell[j * nx + i].push(t);
    }
    b = { x0: bb.min[0], y0: bb.min[1], nx, ny, cell };
    bins.set(T, b);
  }
  const [i, j] = [Math.floor((x - b.x0) / 2), Math.floor((y - b.y0) / 2)];
  if (i < 0 || j < 0 || i >= b.nx || j >= b.ny) return -Infinity;
  let best = -Infinity;
  for (const t of b.cell[j * b.nx + i]) {
    const [a, q, c] = [cornerOf(T, t, 0), cornerOf(T, t, 1), cornerOf(T, t, 2)];
    const den = (q[1] - c[1]) * (a[0] - c[0]) + (c[0] - q[0]) * (a[1] - c[1]);
    if (Math.abs(den) < 1e-12) continue;
    const u = ((q[1] - c[1]) * (x - c[0]) + (c[0] - q[0]) * (y - c[1])) / den;
    const v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / den;
    if (u >= -1e-9 && v >= -1e-9 && u + v <= 1 + 1e-9) best = Math.max(best, u * a[2] + v * q[2] + (1 - u - v) * c[2]);
  }
  return best;
}

/**
 * How high the walls round a piece stand (its frame): the part's top just outside its outline (not its islands': a
 * boss's), the highest, put on the floor height or top just over it (a chamfer or a round on a wall's top edge stands
 * lower); open all round: the top.
 */
function wallTop(r: Rec): number {
  let best = -Infinity;
  for (const loop of r.own) {
    if (signedArea(loop) < 0) continue;
    for (let i = 0; i < loop.length; i++) {
      const [a, b] = [loop[i], loop[(i + 1) % loop.length]];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-9) continue;
      const out: P2 = [(b[1] - a[1]) / len, -(b[0] - a[0]) / len];
      const m = Math.max(1, Math.ceil(len / 0.5));
      for (let q = 0; q < m; q++) {
        const t = (q + 0.5) / m;
        best = Math.max(best, heightAt(r.T, a[0] + (b[0] - a[0]) * t + 0.1 * out[0], a[1] + (b[1] - a[1]) * t + 0.1 * out[1]));
      }
    }
  }
  if (best <= r.h + 0.01) return r.top;
  const up = [...r.levels, r.top].filter((v) => v >= best - 0.005 && v - best <= 3).sort((p, q) => p - q)[0];
  return Math.min(r.top, up ?? best);
}

/** A curved face hollow toward the air (its normals close in on each other going across it: a fillet, not a dome). */
function hollow(T: ArrayLike<number>, f: ExactFace): boolean {
  const pts = f.tris.map((t) => {
    const [p, q, w] = [0, 1, 2].map((c) => cornerOf(T, t, c));
    const u: Vec = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const v: Vec = [w[0] - p[0], w[1] - p[1], w[2] - p[2]];
    const c: Vec = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(...c) || 1;
    return { m: [(p[0] + q[0] + w[0]) / 3, (p[1] + q[1] + w[1]) / 3, (p[2] + q[2] + w[2]) / 3] as Vec, n: [c[0] / l, c[1] / l, c[2] / l] as Vec };
  });
  let sum = 0;
  const step = Math.max(1, Math.floor(pts.length / 60));
  for (let a = 0; a < pts.length; a += step)
    for (let b = a + step; b < pts.length; b += step) sum += dot([pts[a].n[0] - pts[b].n[0], pts[a].n[1] - pts[b].n[1], pts[a].n[2] - pts[b].n[2]], [pts[a].m[0] - pts[b].m[0], pts[a].m[1] - pts[b].m[1], pts[a].m[2] - pts[b].m[2]]);
  return sum < 0;
}

/** How much of a region's edge lies off a box's edge (inside it, not along it). */
function perimeterOff(r: Region, B: Region): number {
  const e = extentOf(B);
  let off = 0;
  for (const l of r)
    for (let i = 0; i < l.length; i++) {
      const [a, b] = [l[i], l[(i + 1) % l.length]];
      const along = (k: 0 | 1) => [e.lo[k], e.hi[k]].some((v) => Math.abs(a[k] - v) < 0.02 && Math.abs(b[k] - v) < 0.02);
      if (!along(0) && !along(1)) off += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
  return off;
}

/** A cylinder's triangles' arcs round its axis (to join with coverage()). */
function arcsOf(P: ArrayLike<number>, f: ExactFace): [number, number][] {
  const a = f.n;
  const u0: Vec = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const d = dot(u0, a);
  const u1: Vec = [u0[0] - d * a[0], u0[1] - d * a[1], u0[2] - d * a[2]];
  const l = Math.hypot(...u1);
  const u: Vec = [u1[0] / l, u1[1] / l, u1[2] / l];
  const w: Vec = [a[1] * u[2] - a[2] * u[1], a[2] * u[0] - a[0] * u[2], a[0] * u[1] - a[1] * u[0]];
  return f.tris.map((t) => arcOf([0, 1, 2].map((c) => {
    const p = cornerOf(P, t, c);
    const q: Vec = [p[0] - f.at[0], p[1] - f.at[1], p[2] - f.at[2]];
    return Math.atan2(dot(q, w), dot(q, u));
  })));
}
