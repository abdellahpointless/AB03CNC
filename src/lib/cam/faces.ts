import type { Vec } from '../toolpath';
import { apply, type Mat3 } from '../orient';

/*
 * The part's exact faces (step 1 of the shape engine): a STEP file gives, for each triangle, the face of the part it lies
 * on (step.ts: stepMesh), and a face's triangle corners lie on its true surface. So each face is fitted as what it is, a
 * plane, a cylinder (a hole's wall, a boss, a rounded corner) or a cone (a countersink, a chamfer at any angle), else
 * "other" (a fillet's torus, a free-form surface), with its exact axis, radius and angle; and which faces meet along an
 * edge, at an inside corner or an outside one. Model frame, mm.
 */

export type FaceKind = 'plane' | 'cylinder' | 'cone' | 'other';

export interface ExactFace {
  id: number;
  kind: FaceKind;
  /** Its triangles (index in the model, every 9 numbers). */
  tris: number[];
  area: number;
  /** plane: its normal (out of the part); cylinder, cone: its axis (unit, either way). */
  n: Vec;
  /** plane: a point on it; cylinder, cone: a point on the axis. */
  at: Vec;
  /** cylinder: its radius (mm). */
  r?: number;
  /** cone: the angle between its surface and its axis (°; a 90° countersink: 45). */
  half?: number;
  /** cylinder, cone: the material outside it (a hole, a countersink), not inside (a boss). */
  concave?: boolean;
  /** cylinder, cone: how far round its axis it goes (°), and its extent along the axis (from `at`). */
  span?: number;
  lo?: number;
  hi?: number;
}

const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec): Vec => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const corner = (P: ArrayLike<number>, t: number, c: number): Vec => [P[t * 9 + c * 3], P[t * 9 + c * 3 + 1], P[t * 9 + c * 3 + 2]];

/** The eigenvectors of a symmetric 3 x 3 matrix (Jacobi), smallest eigenvalue first. */
function eigen(m: number[]): { values: number[]; vectors: Vec[] } {
  const a = m.slice();
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[1]) + Math.abs(a[2]) + Math.abs(a[5]);
    if (off < 1e-14) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      const apq = a[p * 3 + q];
      if (Math.abs(apq) < 1e-18) continue;
      const theta = (a[q * 3 + q] - a[p * 3 + p]) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k * 3 + p];
        const akq = a[k * 3 + q];
        a[k * 3 + p] = c * akp - s * akq;
        a[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p * 3 + k];
        const aqk = a[q * 3 + k];
        a[p * 3 + k] = c * apk - s * aqk;
        a[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p];
        const vkq = v[k * 3 + q];
        v[k * 3 + p] = c * vkp - s * vkq;
        v[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[i * 4] - a[j * 4]);
  return { values: order.map((i) => a[i * 4]), vectors: order.map((i) => [v[i], v[3 + i], v[6 + i]] as Vec) };
}

/** The circle through points in a plane (least squares): its middle and radius, and the worst point's distance off it. */
function circle(pts: [number, number][]): { c: [number, number]; r: number; err: number } | null {
  let [sx, sy, sxx, syy, sxy, sxz, syz, sz] = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const [x, y] of pts) {
    const z = -(x * x + y * y);
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z;
  }
  const n = pts.length;
  const A = [sxx, sxy, sx, sxy, syy, sy, sx, sy, n];
  const det3 = (q: number[]) => q[0] * (q[4] * q[8] - q[5] * q[7]) - q[1] * (q[3] * q[8] - q[5] * q[6]) + q[2] * (q[3] * q[7] - q[4] * q[6]);
  const d = det3(A);
  if (Math.abs(d) < 1e-12) return null;
  const rhs = [sxz, syz, sz];
  const [D, E, F] = [0, 1, 2].map((col) => det3(A.map((v, i) => (i % 3 === col ? rhs[Math.floor(i / 3)] : v))) / d);
  const c: [number, number] = [-D / 2, -E / 2];
  const r = Math.sqrt(Math.max(0, c[0] * c[0] + c[1] * c[1] - F));
  let err = 0;
  for (const [x, y] of pts) err = Math.max(err, Math.abs(Math.hypot(x - c[0], y - c[1]) - r));
  return { c, r, err };
}

/** How far round an axis angles (radians) go: a full turn less the widest gap between them (°). */
function spanOf(angles: number[]): number {
  if (angles.length < 2) return 0;
  const a = [...angles].sort((p, q) => p - q);
  let gap = a[0] + 2 * Math.PI - a[a.length - 1];
  for (let i = 1; i < a.length; i++) gap = Math.max(gap, a[i] - a[i - 1]);
  return ((2 * Math.PI - gap) * 180) / Math.PI;
}

/** Fits one face from its triangles. */
function fit(P: ArrayLike<number>, id: number, tris: number[]): ExactFace {
  let area = 0;
  const S = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const ns: { n: Vec; a: number; m: Vec }[] = [];
  const sum: Vec = [0, 0, 0];
  for (const t of tris) {
    const [p, q, s] = [corner(P, t, 0), corner(P, t, 1), corner(P, t, 2)];
    const x = cross(sub(q, p), sub(s, p));
    const a = Math.hypot(x[0], x[1], x[2]) / 2;
    if (a < 1e-12) continue;
    const n = unit(x);
    area += a;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) S[i * 3 + j] += a * n[i] * n[j];
    for (let i = 0; i < 3; i++) sum[i] += a * n[i];
    ns.push({ n, a, m: [(p[0] + q[0] + s[0]) / 3, (p[1] + q[1] + s[1]) / 3, (p[2] + q[2] + s[2]) / 3] });
  }
  const pts = tris.flatMap((t) => [corner(P, t, 0), corner(P, t, 1), corner(P, t, 2)]);
  const base = { id, tris, area };
  if (!ns.length) return { ...base, kind: 'other', n: [0, 0, 1], at: pts[0] ?? [0, 0, 0] };
  // A plane: every triangle facing the same way (within 0.5°).
  const mean = unit(sum);
  if (ns.every((x) => dot(x.n, mean) > 0.99996)) return { ...base, kind: 'plane', n: mean, at: pts[0] };
  const { vectors } = eigen(S);
  // A cylinder: every normal square to one axis (the eigenvector the normals do not lean along), its corners on a circle.
  // A cone: every normal leaning about the same angle off one axis (a cone's triangles lean up to 3° off it: OpenCascade
  // lays them across it), its corners exactly on it (their distance off the axis growing in step along it). The model's
  // X, Y and Z tried too: a cone a quarter round (a chamfer round a rounded corner) gives no eigenvector along its axis.
  for (const axis of [...vectors, [1, 0, 0], [0, 1, 0], [0, 0, 1]] as Vec[]) {
    const lean = ns.map((x) => dot(x.n, axis));
    const m = lean.reduce((s, v, i) => s + v * ns[i].a, 0) / area;
    const spread = Math.max(...lean.map((v) => Math.abs(v - m)));
    if (spread > (Math.abs(m) < 0.01 ? 0.01 : 0.06)) continue;
    const u = unit(Math.abs(axis[0]) < 0.9 ? cross(axis, [1, 0, 0]) : cross(axis, [0, 1, 0]));
    const w = cross(axis, u);
    if (Math.abs(m) < 0.01) {
      const c = circle(pts.map((p) => [dot(p, u), dot(p, w)]));
      if (!c || c.r < 0.05 || c.err > Math.max(0.005, c.r * 0.002)) continue;
      const at: Vec = [u[0] * c.c[0] + w[0] * c.c[1], u[1] * c.c[0] + w[1] * c.c[1], u[2] * c.c[0] + w[2] * c.c[1]];
      // The material outside: its faces face the axis.
      const inward = ns.reduce((s, x) => {
        const d = sub(x.m, at);
        const radial = sub(d, [axis[0] * dot(d, axis), axis[1] * dot(d, axis), axis[2] * dot(d, axis)]);
        return s + (dot(x.n, radial) < 0 ? x.a : -x.a);
      }, 0);
      const along = pts.map((p) => dot(sub(p, at), axis));
      return { ...base, kind: 'cylinder', n: axis, at, r: c.r, concave: inward > 0, span: spanOf(pts.map((p) => Math.atan2(dot(p, w) - c.c[1], dot(p, u) - c.c[0]))), lo: Math.min(...along), hi: Math.max(...along) };
    }
    if (Math.abs(m) < 0.995) {
      // A point on its axis: the normals' lines all cross it (least squares, in the plane square to the axis).
      let [a11, a12, a22, b1, b2] = [0, 0, 0, 0, 0];
      for (const x of ns) {
        const nu = dot(x.n, u);
        const nw = dot(x.n, w);
        const l = Math.hypot(nu, nw) || 1;
        const [du, dw] = [nu / l, nw / l];
        // Square distance of (cu, cw) to the line through (mu, mw) along (du, dw): (I - d dᵀ).
        const [mu, mw] = [dot(x.m, u), dot(x.m, w)];
        const [p11, p12, p22] = [1 - du * du, -du * dw, 1 - dw * dw];
        a11 += x.a * p11; a12 += x.a * p12; a22 += x.a * p22;
        b1 += x.a * (p11 * mu + p12 * mw); b2 += x.a * (p12 * mu + p22 * mw);
      }
      const det = a11 * a22 - a12 * a12;
      if (Math.abs(det) < 1e-12) continue;
      const [cu, cw] = [(b1 * a22 - b2 * a12) / det, (a11 * b2 - a12 * b1) / det];
      const at: Vec = [u[0] * cu + w[0] * cw, u[1] * cu + w[1] * cw, u[2] * cu + w[2] * cw];
      const inward = ns.reduce((s, x) => {
        const d = sub(x.m, at);
        const radial = sub(d, [axis[0] * dot(d, axis), axis[1] * dot(d, axis), axis[2] * dot(d, axis)]);
        return s + (dot(x.n, radial) < 0 ? x.a : -x.a);
      }, 0);
      const along = pts.map((p) => dot(sub(p, at), axis));
      // Its corners on the cone: their distance off the axis a straight line along it (within 0.01 mm).
      const rho = pts.map((p) => {
        const d = sub(p, at);
        const t = dot(d, axis);
        return Math.hypot(d[0] - axis[0] * t, d[1] - axis[1] * t, d[2] - axis[2] * t);
      });
      const nP = pts.length;
      const [mt, mr] = [along.reduce((a, v) => a + v, 0) / nP, rho.reduce((a, v) => a + v, 0) / nP];
      let [stt, str] = [0, 0];
      for (let i = 0; i < nP; i++) {
        stt += (along[i] - mt) ** 2;
        str += (along[i] - mt) * (rho[i] - mr);
      }
      const slope = stt > 1e-12 ? str / stt : 0;
      if (rho.some((v, i) => Math.abs(v - (mr + slope * (along[i] - mt))) > Math.max(0.01, mr * 0.003))) continue;
      return { ...base, kind: 'cone', n: axis, at, half: (Math.atan(Math.abs(slope)) * 180) / Math.PI, concave: inward > 0, span: spanOf(pts.map((p) => Math.atan2(dot(p, w) - cw, dot(p, u) - cu))), lo: Math.min(...along), hi: Math.max(...along) };
    }
  }
  return { ...base, kind: 'other', n: mean, at: pts[0] };
}

/** The part's exact faces from its triangles and the face each lies on (-1: none). */
export function exactFaces(P: ArrayLike<number>, faceOf: ArrayLike<number>): ExactFace[] {
  const by = new Map<number, number[]>();
  for (let t = 0; t < faceOf.length; t++) if (faceOf[t] >= 0) (by.get(faceOf[t]) ?? by.set(faceOf[t], []).get(faceOf[t])!).push(t);
  return [...by].sort((a, b) => a[0] - b[0]).map(([id, tris]) => fit(P, id, tris));
}

/**
 * Which faces meet along an edge, and how: an inside corner (concave: the material on both sides goes up from it, a
 * pocket's floor and wall) or an outside one (convex: an outline's edge). Pairs of face ids, the smaller first.
 */
export function faceEdges(P: ArrayLike<number>, faceOf: ArrayLike<number>): { a: number; b: number; concave: boolean }[] {
  const key = (p: Vec) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)},${Math.round(p[2] * 1000)}`;
  const at = new Map<string, number>();
  const out = new Map<string, { a: number; b: number; concave: number }>();
  for (let t = 0; t < faceOf.length; t++) {
    if (faceOf[t] < 0) continue;
    for (let c = 0; c < 3; c++) {
      const [k1, k2] = [key(corner(P, t, c)), key(corner(P, t, (c + 1) % 3))];
      const e = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
      const o = at.get(e);
      if (o === undefined) {
        at.set(e, t);
        continue;
      }
      if (faceOf[o] === faceOf[t]) continue;
      // The other triangle's middle in front of this one's face: an inside corner.
      const [p, q, s] = [corner(P, t, 0), corner(P, t, 1), corner(P, t, 2)];
      const n = unit(cross(sub(q, p), sub(s, p)));
      const m: Vec = [0, 1, 2].map((i) => (P[o * 9 + i] + P[o * 9 + 3 + i] + P[o * 9 + 6 + i]) / 3) as Vec;
      const [a, b] = [Math.min(faceOf[o], faceOf[t]), Math.max(faceOf[o], faceOf[t])];
      const pair = out.get(`${a}:${b}`) ?? out.set(`${a}:${b}`, { a, b, concave: 0 }).get(`${a}:${b}`)!;
      pair.concave += dot(n, sub(m, p)) > 1e-6 ? 1 : -1;
    }
  }
  return [...out.values()].map((x) => ({ a: x.a, b: x.b, concave: x.concave > 0 }));
}

/**
 * Round holes along a side's tool axis from the exact cylinders (features.ts: cylinders' place for a STEP model): the
 * faces of one hole (a STEP file often splits a hole's wall in two) joined, its exact middle and radius in the side's
 * frame (p' = R p), its top and bottom; a wall a third of the way round or more, as the mesh reader takes.
 */
export function exactCylinders(faces: ExactFace[], R: Mat3): { c: [number, number]; r: number; lo: number; hi: number; concave: boolean; closed: boolean; err: number }[] {
  const along = faces.filter((f) => f.kind === 'cylinder' && Math.abs(apply(R, f.n)[2]) > 0.9999);
  const groups: { c: [number, number]; r: number; lo: number; hi: number; concave: boolean; span: number }[] = [];
  for (const f of along) {
    const c3 = apply(R, f.at);
    const dz = apply(R, f.n)[2];
    // Its extent along the axis, as heights in the side's frame.
    const z = [f.lo!, f.hi!].map((v) => c3[2] + v * dz);
    const [lo, hi] = [Math.min(...z), Math.max(...z)];
    const g = groups.find((x) => Math.hypot(x.c[0] - c3[0], x.c[1] - c3[1]) < 0.01 && Math.abs(x.r - f.r!) < 0.005 && x.concave === !!f.concave && lo <= x.hi + 0.01 && hi >= x.lo - 0.01);
    if (g) {
      g.lo = Math.min(g.lo, lo);
      g.hi = Math.max(g.hi, hi);
      g.span = Math.min(360, g.span + f.span!);
    } else groups.push({ c: [c3[0], c3[1]], r: f.r!, lo, hi, concave: !!f.concave, span: f.span! });
  }
  // Closed: no gap over 50° round it (a face's corners stand a segment apart), as the mesh reader takes it.
  return groups.filter((g) => g.span >= 120).map((g) => ({ c: g.c, r: g.r, lo: g.lo, hi: g.hi, concave: g.concave, closed: g.span >= 310, err: 0 }));
}
