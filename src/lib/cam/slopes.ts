/**
 * Flat slopes cut from above with a ball end mill (you, 2026-11-27: "ball mill from the top", not clamped on the side and
 * cut as a wall): a STEP model's plane faces that a clamping sees tilted, and the ball's passes over them.
 */
import type { P2 } from './geom';
import type { ExactFace } from './faces';

type V3 = [number, number, number];

export interface Slope {
  id: number;
  /** Its normal in the clamping's frame (unit, out of the part: up). */
  n: V3;
  /** n · p on it. */
  d: number;
  /** Its triangles (indices into the clamping's triangles, the model's own). */
  tris: number[];
  /** Its lowest point (the clamping's Z). */
  lo: number;
}

const corner = (P: ArrayLike<number>, t: number, c: number): V3 => [P[t * 9 + c * 3], P[t * 9 + c * 3 + 1], P[t * 9 + c * 3 + 2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Where a vertical line through (x, y) meets triangle t, if it does (its Z there), else null. */
function zOn(P: ArrayLike<number>, t: number, x: number, y: number): number | null {
  const [a, b, c] = [corner(P, t, 0), corner(P, t, 1), corner(P, t, 2)];
  const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(det) < 1e-12) return null;
  const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / det;
  const l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / det;
  const l3 = 1 - l1 - l2;
  return l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9 ? null : l1 * a[2] + l2 * b[2] + l3 * c[2];
}

/**
 * A clamping's flat slopes: plane faces 3° to 85° off the horizontal in its frame (P: the model's triangles turned into
 * it), every edge an outside one (no wall rising from it for the ball to cut into), nothing of the part over them; a
 * 45° face under 3 mm across is a chamfer (the graver's), not a slope.
 */
export function slopesOf(P: ArrayLike<number>, faces: ExactFace[], edges: { a: number; b: number; concave: boolean }[]): Slope[] {
  const inside = new Set(edges.filter((e) => e.concave).flatMap((e) => [e.a, e.b]));
  const n = P.length / 9;
  const out: Slope[] = [];
  for (const f of faces) {
    if (f.kind !== 'plane' || inside.has(f.id) || !f.tris.length) continue;
    // Its normal in this frame from its own triangles (out of the part, area-weighted).
    const s: V3 = [0, 0, 0];
    for (const t of f.tris) {
      const [a, b, c] = [corner(P, t, 0), corner(P, t, 1), corner(P, t, 2)];
      const u: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const v: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      s[0] += u[1] * v[2] - u[2] * v[1];
      s[1] += u[2] * v[0] - u[0] * v[2];
      s[2] += u[0] * v[1] - u[1] * v[0];
    }
    const len = Math.hypot(...s);
    if (!len) continue;
    const nv: V3 = [s[0] / len, s[1] / len, s[2] / len];
    if (nv[2] < Math.cos((85 * Math.PI) / 180) || nv[2] > Math.cos((3 * Math.PI) / 180)) continue;
    const pts = f.tris.flatMap((t) => [corner(P, t, 0), corner(P, t, 1), corner(P, t, 2)]);
    const h = Math.hypot(nv[0], nv[1]);
    const g: P2 = [nv[0] / h, nv[1] / h];
    const along = pts.map((p) => p[0] * g[0] + p[1] * g[1]);
    const across = (Math.max(...along) - Math.min(...along)) / nv[2];
    if (Math.abs(nv[2] - Math.SQRT1_2) < 0.02 && across < 3) continue;
    // Nothing of the part over it: every triangle's middle seen from straight above.
    const own = new Set(f.tris);
    const seen = f.tris.every((t) => {
      const m = [0, 1, 2].map((k) => (P[t * 9 + k] + P[t * 9 + 3 + k] + P[t * 9 + 6 + k]) / 3);
      for (let o = 0; o < n; o++) {
        if (own.has(o)) continue;
        const z = zOn(P, o, m[0], m[1]);
        if (z !== null && z > m[2] + 0.01) return false;
      }
      return true;
    });
    if (!seen) continue;
    out.push({ id: f.id, n: nv, d: dot(nv, pts[0]), tris: f.tris, lo: Math.min(...pts.map((p) => p[2])) });
  }
  return out;
}

/**
 * The ball's passes over a slope (r: its radius, mm): along the slope's level lines, each at one Z, the next one down its
 * fall, `scallop` mm high between them (measured on the face); each over the face's width there and on 1 mm past it, its
 * centre `stock` mm further out than touching it. Tips (the programmed point: the ball's bottom), in passes top down.
 */
export function slopePasses(P: ArrayLike<number>, s: Slope, r: number, scallop: number, stock = 0): { z: number; a: P2; b: P2 }[] {
  const h = Math.hypot(s.n[0], s.n[1]);
  const g: P2 = [s.n[0] / h, s.n[1] / h];
  const u: P2 = [-g[1], g[0]];
  const tri = s.tris.map((t) => [corner(P, t, 0), corner(P, t, 1), corner(P, t, 2)]);
  const along = tri.flat().map((p) => p[0] * g[0] + p[1] * g[1]);
  const [c0, c1] = [Math.min(...along), Math.max(...along)];
  // Across the face between two passes: 2 √(2 r s - s²) for a scallop s; along the fall seen from above, that × cos.
  const step = 2 * Math.sqrt(Math.max(1e-6, 2 * r * scallop - scallop * scallop)) * s.n[2];
  const count = Math.max(1, Math.ceil((c1 - c0) / step));
  const passes: { z: number; a: P2; b: P2 }[] = [];
  for (let i = 0; i <= count; i++) {
    // The first and last a hundredth inside its edges: on an edge the triangles meet it in a point.
    const c = c0 + 0.01 + ((c1 - c0 - 0.02) * i) / count;
    // Where its level line crosses the face: each triangle's stretch of it, joined.
    const spans: [number, number][] = [];
    for (const [a, b, cc] of tri) {
      const ts: number[] = [];
      for (const [p, q] of [[a, b], [b, cc], [cc, a]] as [V3, V3][]) {
        const [dp, dq] = [p[0] * g[0] + p[1] * g[1] - c, q[0] * g[0] + q[1] * g[1] - c];
        if ((dp <= 1e-9 && dq >= -1e-9) || (dp >= -1e-9 && dq <= 1e-9)) {
          const k = Math.abs(dp - dq) < 1e-12 ? 0 : dp / (dp - dq);
          ts.push((p[0] + (q[0] - p[0]) * k) * u[0] + (p[1] + (q[1] - p[1]) * k) * u[1]);
        }
      }
      if (ts.length >= 2) spans.push([Math.min(...ts), Math.max(...ts)]);
    }
    spans.sort((p, q) => p[0] - q[0]);
    const joined: [number, number][] = [];
    for (const sp of spans) {
      const last = joined.at(-1);
      if (last && sp[0] <= last[1] + 0.05) last[1] = Math.max(last[1], sp[1]);
      else joined.push([...sp]);
    }
    // The face's Z on this line, and the ball's centre stock + r out along its normal: its tip r under that.
    const z = (s.d - h * c) / s.n[2];
    const out = r + stock;
    const tip = z + out * s.n[2] - r;
    for (const [t0, t1] of joined) {
      const at = (t: number): P2 => [c * g[0] + t * u[0] + out * s.n[0], c * g[1] + t * u[1] + out * s.n[1]];
      passes.push({ z: tip, a: at(t0 - 1), b: at(t1 + 1) });
    }
  }
  return passes;
}
