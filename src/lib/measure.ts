import type { Vec } from './toolpath';
import type { Hole } from './stockSim';

/*
 * Measuring on the simulated part (part frame, mm). What a click picks depends on the mode: a flat
 * face square to an axis (its exact height on the cut surface), a hole (plunged or bored: its Ø is
 * known from the moves), or a point on the surface. Two picks measure the distance between them.
 */

export type MeasureMode = 'faces' | 'points' | 'diameter' | 'axes';

export type Feature = { kind: 'face'; axis: 0 | 1 | 2; at: number; sign: 1 | -1; p: Vec } | { kind: 'hole'; hole: Hole } | { kind: 'point'; p: Vec };

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec) => Math.hypot(a[0], a[1], a[2]);
const scale = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k, a[2] * k];
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** Unit direction into the hole (rim to bottom) and its depth at full Ø. */
export function holeAxis(h: Hole): { u: Vec; depth: number } {
  const d = sub(h.bottom, h.top);
  const depth = len(d);
  return { u: scale(d, 1 / (depth || 1)), depth };
}

/** The hole a point on the surface belongs to: on its wall, or on the face just round its rim. */
export function holeAt(holes: Hole[], p: Vec): Hole | null {
  let best: Hole | null = null;
  let err = Infinity;
  for (const h of holes) {
    const { u, depth } = holeAxis(h);
    const w = sub(p, h.top);
    const t = dot(w, u);
    if (t < -0.6 || t > depth + 0.6) continue;
    const radial = len(sub(w, scale(u, t)));
    // On the wall: at the radius. On the rim's face: a little outside it.
    const e = t < 0.4 && radial >= h.r - 0.6 && radial < h.r + 1.2 ? Math.max(0, radial - h.r) * 0.5 : Math.abs(radial - h.r);
    if (e < 0.6 && e < err) {
      err = e;
      best = h;
    }
  }
  return best;
}

/**
 * Distance between two features, or null when they do not face the same way (two faces on
 * different axes, holes not parallel). Faces and a face with a hole: along the face's axis. Two
 * parallel holes: between their axes. Two points: straight from one to the other.
 */
export function between(a: Feature, b: Feature): { mm: number; from: Vec; to: Vec; dir: Vec } | null {
  if (a.kind === 'point' || b.kind === 'point') {
    const pa = a.kind === 'point' ? a.p : a.kind === 'face' ? a.p : a.hole.top;
    const pb = b.kind === 'point' ? b.p : b.kind === 'face' ? b.p : b.hole.top;
    const d = sub(pb, pa);
    const mm = len(d);
    return { mm, from: pa, to: pb, dir: scale(d, 1 / (mm || 1)) };
  }
  if (a.kind === 'face' || b.kind === 'face') {
    const face = (a.kind === 'face' ? a : b) as Extract<Feature, { kind: 'face' }>;
    const other = face === a ? b : a;
    if (other.kind === 'face' && other.axis !== face.axis) return null;
    const at = other.kind === 'face' ? other.at : other.hole.top[face.axis];
    const from = other.kind === 'face' ? other.p : other.hole.top;
    const to: Vec = [...from];
    to[face.axis] = face.at;
    const dir: Vec = [0, 0, 0];
    dir[face.axis] = 1;
    return face === a ? { mm: Math.abs(at - face.at), from: to, to: from, dir } : { mm: Math.abs(at - face.at), from, to, dir };
  }
  const ua = holeAxis(a.hole).u;
  const ub = holeAxis(b.hole).u;
  if (Math.abs(dot(ua, ub)) < 0.99) return null;
  const d = sub(b.hole.top, a.hole.top);
  const across = sub(d, scale(ua, dot(d, ua)));
  const mm = len(across);
  return { mm, from: a.hole.top, to: add(a.hole.top, across), dir: scale(across, 1 / (mm || 1)) };
}

/**
 * Where to draw a dimension so it stands clear of the part: a line parallel to `dir` through the
 * ends' projections, moved out of the box (part extent) square to `dir`, away from its middle.
 * Returns the two ends of the dimension line and where its label goes.
 */
export function placeDimension(from: Vec, to: Vec, dir: Vec, box: { min: Vec; max: Vec }, margin: number): { a: Vec; b: Vec; label: Vec } {
  const mid = scale(add(from, to), 0.5);
  const centre = scale(add(box.min, box.max), 0.5);
  let out = sub(mid, centre);
  out = sub(out, scale(dir, dot(out, dir)));
  if (len(out) < 1e-6) {
    // Straight through the middle: out along the box's widest axis square to the line.
    const k = [0, 1, 2].filter((i) => Math.abs(dir[i]) < 0.9).sort((i, j) => box.max[j] - box.min[j] - (box.max[i] - box.min[i]))[0] ?? 0;
    out = [0, 0, 0];
    out[k] = 1;
  }
  out = scale(out, 1 / len(out));
  // How far from the middle until out of the box.
  let s = Infinity;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(out[k]) < 1e-9) continue;
    s = Math.min(s, ((out[k] > 0 ? box.max[k] : box.min[k]) - mid[k]) / out[k]);
  }
  const line = add(mid, scale(out, Math.max(0, Number.isFinite(s) ? s : 0) + margin));
  const a = add(line, scale(dir, dot(sub(from, mid), dir)));
  const b = add(line, scale(dir, dot(sub(to, mid), dir)));
  return { a, b, label: add(line, scale(out, margin * 0.35)) };
}
