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

/** What of the part (P, a frame's triangles) stands above height z, seen from above. */
function shadow(P: ArrayLike<number>, z: number): Region {
  const polys: Region = [];
  for (let t = 0; t < P.length / 9; t++) {
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
  /** The deeper piece round the island it lies over (the room over a boss is that pocket's). */
  into?: Rec;
  /** The grid cells (not the part) its room holds. */
  cells?: Int32Array;
}

/** The shapes of a STEP model: P its triangles (the model's frame), faceOf each one's exact face. */
export function recognizeFaces(P: ArrayLike<number>, faceOf: ArrayLike<number>, faces: ExactFace[] = exactFaces(P, faceOf)): Recognition {
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
  // there, in pieces; each piece's own room what no deeper piece takes (that one starts at this floor, but its room
  // is its own all the way up); a hole's disc is the hole's. The room over an island (a boss's top) is the room of the
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
    // The holes along this side's axis, in this frame: a piece that is one of their discs is that hole.
    const [i0, j0] = others(k);
    const discs = holeDiscs.filter((d) => d.k === k).map((d) => {
      const p: Vec = [0, 0, 0];
      p[i0] = d.c[0];
      p[j0] = d.c[1];
      const q = apply(R, p);
      return { c: [q[0], q[1]] as P2, r: d.r };
    });
    const isDisc = (K: Region) => discs.some((d) => inside(K, d.c) !== 0 && Math.abs(area(K) - area(intersection(circle(d.c, d.r), B))) < 0.03 * Math.PI * d.r * d.r + 0.05);
    const pieces: { h: number; K: Region; disc: boolean }[] = [];
    for (const h of levels) {
      const A = clean(difference(B, shadow(T, h + EPS)));
      for (const K of components(A)) if (area(K) > 0.05) pieces.push({ h, K, disc: isDisc(K) });
    }
    const mine: Rec[] = [];
    for (const p of pieces) {
      if (p.disc) continue;
      const deeper = pieces.filter((q) => q.h < p.h - 0.001 && !q.disc).map((q) => q.K);
      const own = clean(deeper.length ? difference(p.K, union(deeper.flat())) : p.K);
      if (area(own) < 0.5) continue;
      mine.push({ side: s.name, R, T, h: p.h, top, own, through: p.h === bot, B, faces: [] });
    }
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
      const piece = clean(difference(r.B, shadow(T, r.h + EPS)));
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
          if (area(intersection(S, piece)) < area(intersection(S, r.B)) - 0.05) continue;
          split.push({ ...r, own: clean(inS), kind: 'slot', width: r3(hi - lo), faces: [] });
          rest = clean(difference(rest, S));
        }
      }
    }
    if (area(rest) >= 0.5) split.push({ ...r, own: rest });
  }
  for (const r of split) if (r.into) r.into = split.find((o) => o.side === r.side && o.h === r.into!.h && area(intersection(o.own, r.into!.own)) > 0.05) ?? r.into;

  // 4. Each piece's faces: its floor's flat faces under it, its walls along its edge between its floor and the top. A
  // face is the piece's that holds most of it (the first side's on a tie: a slot's walls are its floor's piece's, not
  // those of the same slot seen through from its end), and only if it holds half of it or more.
  const pieces = split.filter((r) => !r.into);
  const share = new Map<number, { r: Rec; a: number }>();
  for (const r of pieces) {
    const T = r.T;
    const inG = insideFn(offset(r.own, 0.05));
    const shrunk = offset(r.own, -0.05);
    const inS = shrunk.length ? insideFn(shrunk) : () => false;
    for (const f of faces) {
      if (holeFaces.has(f.id)) continue;
      let a = 0;
      for (const t of f.tris) {
        const z = centroidZ(T, t);
        if (z < r.h - 0.01 || z > r.top + 0.01) continue;
        const xy = centroidXY(T, t);
        const floor = normalZ(T, t) > 0.9999 && Math.abs(z - r.h) < 0.01;
        if (floor ? inG(xy) : inG(xy) && !inS(xy)) a += triArea(T, t);
      }
      const best = share.get(f.id);
      if (a >= 0.5 * f.area && (!best || a > best.a * (1 + 1e-6))) share.set(f.id, { r, a });
    }
  }
  for (const [fid, { r }] of share) r.faces.push(fid);

  // 5. Shapes: the pieces with faces of their own, the same room (its cells) from several sides once. A piece with
  // none is a view of other shapes (the top half of a pocket seen through a step from the side): nothing of its own,
  // unless no shape holds its room. A shape is reached from every side whose pieces' rooms hold all of it.
  for (const r of split) r.cells = prismCells(grid, r);
  for (const r of split) if (r.into) r.into.cells = Int32Array.from([...r.into.cells!, ...r.cells!]);
  type Group = { recs: Rec[]; mask: Uint8Array; count: number };
  const groups: Group[] = [];
  const held = new Uint8Array(grid.part.length);
  const bySize = (a: Rec, b: Rec) => Number(a.through) - Number(b.through) || b.cells!.length - a.cells!.length;
  const live = pieces.filter((r) => r.cells!.length);
  const order = [...live.filter((r) => r.faces.length).sort(bySize), ...live.filter((r) => !r.faces.length).sort(bySize)];
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
    if (!r.faces.length) {
      let inHeld = 0;
      for (const id of c) if (held[id]) inHeld++;
      if (inHeld >= 0.98 * c.length) continue;
    }
    const mask = new Uint8Array(grid.part.length);
    for (const id of c) [mask[id], held[id]] = [1, 1];
    groups.push({ recs: [r], mask, count: c.length });
  }
  const seenFrom = new Map(SIDES.map((s) => {
    const m = new Uint8Array(grid.part.length);
    for (const r of split) if (r.side === s.name) for (const id of r.cells!) m[id] = 1;
    return [s.name, m] as const;
  }));
  const rank: FeatureKind[] = ['pocket', 'slot', 'notch', 'step', 'window', 'outline'];
  for (const g of groups) {
    // Named from the side it has a floor on (a pocket before a slot before a step...).
    const named = g.recs.map((r) => ({ r, kind: r.kind ?? kindOf(r) }));
    const { r, kind: k0 } = named.filter((x) => !x.r.through).sort((a, b) => rank.indexOf(a.kind) - rank.indexOf(b.kind))[0] ?? named[0];
    const fs = [...new Set(g.recs.flatMap((x) => x.faces))].sort((a, b) => a - b);
    const from = new Set(g.recs.map((x) => x.side));
    for (const [side, m] of seenFrom) {
      let inside2 = 0;
      for (let id = 0; id < m.length; id++) if (g.mask[id] && m[id]) inside2++;
      if (inside2 >= 0.95 * g.count) from.add(side);
    }
    let kind = k0;
    // Walled only by tilted flat faces: a slope (or a chamfer), whichever side it is seen from.
    const tilted = fs.length > 0 && fs.every((id) => byId.get(id)!.kind === 'plane' && axisOf(byId.get(id)!.n) < 0);
    let angle: number | undefined;
    if (tilted) {
      const f = byId.get(fs.sort((a, b) => byId.get(b)!.area - byId.get(a)!.area)[0])!;
      const ka = [0, 1, 2].sort((a, b) => Math.abs(f.n[b]) - Math.abs(f.n[a]))[0];
      kind = 'slope';
      angle = r3((Math.acos(Math.min(1, Math.abs(f.n[ka]))) * 180) / Math.PI);
      from.add(`${AX[ka]}${f.n[ka] > 0 ? '+' : '-'}`);
    }
    const T = r.T;
    const mineFaces = r.faces.map((id) => byId.get(id)!);
    const wallTop = Math.max(r.h, ...mineFaces.flatMap((f) => f.tris.flatMap((t) => [0, 1, 2].map((c) => T[t * 9 + c * 3 + 2]))));
    const e = extentOf(r.own);
    const Rt = transpose(r.R);
    const corner = mineFaces.filter((f) => f.kind === 'cylinder' && f.concave && axisOf(apply(r.R, f.n)) === 2 && (f.span ?? 360) <= 181).map((f) => f.r!);
    const width = kind === 'slot' ? (r.width ?? slotWidth(r, mineFaces)) : undefined;
    features.push({
      kind,
      from: [...from].sort(),
      faces: fs,
      box: snap(boxOf(Rt, [e.lo[0], e.lo[1], r.h], [e.hi[0], e.hi[1], r.top]), fs.map((id) => byId.get(id)!), P),
      ...(kind === 'slope' ? { angle } : r.through ? { through: true } : { depth: r3(Math.min(r.top, wallTop) - r.h) }),
      ...(corner.length && kind !== 'slope' ? { corner: r3(Math.min(...corner)) } : {}),
      ...(width !== undefined ? { width } : {}),
    });
    // Bosses: the part standing up inside it (its outline's holes), from the floor to its own top.
    for (const loop of r.own.filter((l) => signedArea(l) < 0)) {
      const isl = [loop.slice().reverse()] as Region;
      const inI = insideFn(isl);
      const inI5 = insideFn(offset(isl, 0.05));
      const topI = Math.max(...faces.filter((f) => f.kind === 'plane' && apply(r.R, f.n)[2] > 0.9999).filter((f) => f.tris.some((t) => inI(centroidXY(T, t)))).map((f) => apply(r.R, f.at)[2]), r.h);
      const ie = extentOf(isl);
      const bossFaces = faces.filter((f) => !holeFaces.has(f.id) && f.tris.some((t) => inI5(centroidXY(T, t)) && centroidZ(T, t) > r.h + 0.01 && centroidZ(T, t) <= topI + 0.01)).map((f) => f.id);
      const cyl = bossFaces.map((id) => byId.get(id)!).find((f) => f.kind === 'cylinder' && !f.concave);
      features.push({ kind: 'boss', from: [r.side], faces: bossFaces, box: snap(boxOf(Rt, [ie.lo[0], ie.lo[1], r.h], [ie.hi[0], ie.hi[1], topI]), bossFaces.map((id) => byId.get(id)!), P), height: r3(topI - r.h), ...(cyl ? { d: r3(2 * cyl.r!) } : {}) });
    }
  }

  // 6. What is left: the edges' chamfers, rounds and fillets, slopes, 3D surfaces; the box's own faces are the stock's.
  const owned = new Set(features.flatMap((f) => f.faces));
  const stock = (f: ExactFace) => f.kind === 'plane' && axisOf(f.n) >= 0 && Math.abs(f.at[axisOf(f.n)] - (f.n[axisOf(f.n)] > 0 ? bb.max : bb.min)[axisOf(f.n)]) < 0.01;
  const edges: { kind: FeatureKind; key: string; f: ExactFace; size?: number; angle?: number; r?: number; from?: string[] }[] = [];
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
      const drop = Math.max(...pts.map((p) => p[k])) - Math.min(...pts.map((p) => p[k]));
      const h = Math.hypot(...([0, 1, 2].map((a) => (a === k ? 0 : f.n[a])) as Vec));
      const g: Vec = [0, 1, 2].map((a) => (a === k ? 0 : f.n[a] / h)) as Vec;
      const run = Math.max(...pts.map((p) => dot(p, g))) - Math.min(...pts.map((p) => dot(p, g)));
      const narrow = Math.min(drop, run) <= 3 && Math.max(drop, run) <= 4.5;
      // A chamfer is reached from every side its face looks toward (a 45° one: both); a slope from the one it looks to most.
      const toward = [0, 1, 2].filter((a) => Math.abs(f.n[a]) >= 0.25).map((a) => `${AX[a]}${f.n[a] > 0 ? '+' : '-'}`);
      if (narrow) edges.push({ kind: 'chamfer', key: planeKey(f), f, size: r3(Math.max(drop, run)), angle: r3(tilt), from: toward });
      else edges.push({ kind: 'slope', key: planeKey(f), f, angle: r3(tilt), from: [`${AX[k]}${f.n[k] > 0 ? '+' : '-'}`] });
    } else if (f.kind === 'cylinder') edges.push({ kind: f.concave ? 'fillet' : 'round', key: `${f.n.map((v) => r3(Math.abs(v))).join(',')}|${r3(f.r!)}|${dist2(f)}`, f, r: r3(f.r!) });
    else if (f.kind === 'cone') edges.push({ kind: 'chamfer', key: `${f.id}`, f, angle: r3(f.half ?? 0), size: r3((f.hi ?? 0) - (f.lo ?? 0)) });
    else edges.push({ kind: 'surface', key: `${f.id}`, f });
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

  // 7. The check: the material between the part and its box, every bit of it explained by a shape.
  const unexplained = check(P, grid, split, features, byId);
  return { features, unexplained, unowned };
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

function kindOf(r: Rec): FeatureKind {
  const e = extentOf(r.B);
  const o = extentOf(r.own);
  const touch = { xlo: o.lo[0] < e.lo[0] + 0.02, xhi: o.hi[0] > e.hi[0] - 0.02, ylo: o.lo[1] < e.lo[1] + 0.02, yhi: o.hi[1] > e.hi[1] - 0.02 };
  const n = Object.values(touch).filter(Boolean).length;
  if (!n) return r.through ? 'window' : 'pocket';
  if (r.through) return 'outline';
  // Open on three sides or round a corner: a step; right across, open at its two ends: a slot; open on one side: a
  // step along all of it, else a notch.
  if (n >= 3) return 'step';
  if (n === 2) return (touch.xlo && touch.xhi) || (touch.ylo && touch.yhi) ? 'slot' : 'step';
  const full = touch.xlo || touch.xhi ? o.hi[1] - o.lo[1] > e.hi[1] - e.lo[1] - 0.05 : o.hi[0] - o.lo[0] > e.hi[0] - e.lo[0] - 0.05;
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
function slotWidth(r: Rec, fs: ExactFace[]): number | undefined {
  const w = fs.filter((f) => f.kind === 'plane').map((f) => ({ n: apply(r.R, f.n), at: apply(r.R, f.at) })).filter((x) => Math.abs(x.n[2]) < 1e-4 && axisOf(x.n) >= 0);
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
    const i0 = Math.max(0, Math.ceil((Math.min(a[0], b[0], c[0]) - bb.min[0]) / st[0] - 0.5));
    const i1 = Math.min(n[0] - 1, Math.floor((Math.max(a[0], b[0], c[0]) - bb.min[0]) / st[0] - 0.5));
    const j0 = Math.max(0, Math.ceil((Math.min(a[1], b[1], c[1]) - bb.min[1]) / st[1] - 0.5));
    const j1 = Math.min(n[1] - 1, Math.floor((Math.max(a[1], b[1], c[1]) - bb.min[1]) / st[1] - 0.5));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const [x, y] = [bb.min[0] + (i + 0.5) * st[0] + 1e-7, bb.min[1] + (j + 0.5) * st[1] + 1.3e-7];
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
function check(P: ArrayLike<number>, g: Grid, recs: Rec[], features: Feature[], byId: Map<number, ExactFace>): { mm3: number; box: Box6 }[] {
  const { bb, n, st, part } = g;
  const idx = (i: number, j: number, k: number) => (k * n[1] + j) * n[0] + i;
  const done = new Uint8Array(part.length);
  // Milled shapes: every piece's room (those merged or dropped as another's too: the room is removed all the same).
  for (const r of recs) for (const id of r.cells ?? prismCells(g, r)) done[id] = 1;
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
    } else if (['chamfer', 'round', 'fillet', 'slope', 'surface'].includes(f.kind)) {
      for (const h of fs) {
        const reach = f.kind === 'round' || f.kind === 'fillet' ? f.r! : f.kind === 'chamfer' ? f.size! : Math.max(...[0, 1, 2].map((k) => Math.max(...h.tris.flatMap((t) => [0, 1, 2].map((c) => cornerOf(P, t, c)[k]))) - Math.min(...h.tris.flatMap((t) => [0, 1, 2].map((c) => cornerOf(P, t, c)[k])))));
        const near = reach + Math.max(...st);
        for (const t of h.tris) {
          const tri = [0, 1, 2].map((c) => cornerOf(P, t, c));
          const lo = [0, 1, 2].map((k) => Math.min(...tri.map((p) => p[k])) - near);
          const hi = [0, 1, 2].map((k) => Math.max(...tri.map((p) => p[k])) + near);
          mark(done, part, n, st, bb, (p) => distToTri(p, tri) <= near, [0, lo[0], hi[0]], [1, lo[1], hi[1]], [2, lo[2], hi[2]]);
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
