import { ShapeUtils, Vector2 } from 'three';
import type { Vec } from '../toolpath';
import type { P2 } from './geom';
import { NEST_FLOOR, NEST_GAP, NEST_WALL } from '../setups';

/*
 * The last way to hold a part (shop rule: only when no way of holding it in the vise passes the
 * physics, it would slip, tip or deform): a POM block with a pocket the part sits in. Headless M4
 * set screws through two side walls (X- and Y-) push it against the opposite walls; the floor
 * carries it all over; the vise grips the block. CAM AI programs the block like any part (pocket,
 * Ø3.3 holes from the sides); the operator taps M4 by hand.
 */

export const NEST = { wall: NEST_WALL, floor: NEST_FLOOR, clearance: NEST_GAP, tapDrill: 3.3, minDepth: 6 };

export interface Nest {
  /** Block size (X, Y, Z) and its lowest corner, in the part's setup frame (mm). */
  size: Vec;
  min: Vec;
  /** The pocket: its X, Y extent (setup frame) and depth from the block's top. */
  pocket: { lo: P2; hi: P2; depth: number };
  /** The set screws: the wall each goes through and its axis on the block's outer face. */
  screws: { face: 'X-' | 'Y-'; at: Vec }[];
  /** The block as triangles (setup frame): for its program and the 3D view. */
  tris: Float32Array;
}

const SEGMENTS = 24;
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * The nest for a part whose outline spans lo..hi (X, Y) with its bottom at z0, the pocket `depth`
 * deep (at least NEST.minDepth, room for the screws).
 */
export function nestFor(lo: P2, hi: P2, z0: number, depth: number): Nest {
  const d = Math.max(NEST.minDepth, depth);
  const c = NEST.clearance;
  const [px0, py0, px1, py1] = [lo[0] - c, lo[1] - c, hi[0] + c, hi[1] + c];
  const [x0, y0, x1, y1] = [px0 - NEST.wall, py0 - NEST.wall, px1 + NEST.wall, py1 + NEST.wall];
  const zp = z0;
  const zt = z0 + d;
  const zb = z0 - NEST.floor;
  const zs = zp + d / 2;
  const r = NEST.tapDrill / 2;
  // One screw per wall, two on a wall over 30 mm, a quarter in from its ends.
  const spots = (a: number, b: number) => (b - a > 30 ? [a + (b - a) / 4, a + (3 * (b - a)) / 4] : [(a + b) / 2]);
  const screws: Nest['screws'] = [...spots(py0, py1).map((y) => ({ face: 'X-' as const, at: [x0, y, zs] as Vec })), ...spots(px0, px1).map((x) => ({ face: 'Y-' as const, at: [x, y0, zs] as Vec }))];
  // A circle in a wall's own 2D coordinates (the coordinate along the wall, then Z), shared exactly
  // by the wall faces and the hole's side so the mesh closes.
  const ring = (u: number): P2[] => Array.from({ length: SEGMENTS }, (_, k) => [u + r * Math.cos((2 * Math.PI * k) / SEGMENTS), zs + r * Math.sin((2 * Math.PI * k) / SEGMENTS)]);
  const xHoles = screws.filter((s) => s.face === 'X-').map((s) => ring(s.at[1]));
  const yHoles = screws.filter((s) => s.face === 'Y-').map((s) => ring(s.at[0]));

  const out: number[] = [];
  /** A flat face: outline and holes in 2D, to 3D by `to`, wound so its normal is `n`. */
  const face = (outer: P2[], holes: P2[][], to: (p: P2) => Vec, n: Vec) => {
    const all = [...outer, ...holes.flat()];
    for (const [i, j, k] of ShapeUtils.triangulateShape(outer.map(([a, b]) => new Vector2(a, b)), holes.map((h) => h.map(([a, b]) => new Vector2(a, b))))) {
      const [a, b, cc] = [to(all[i]), to(all[j]), to(all[k])];
      out.push(...(dot(cross(sub(b, a), sub(cc, a)), n) >= 0 ? [...a, ...b, ...cc] : [...a, ...cc, ...b]));
    }
  };
  const rect = (a0: number, b0: number, a1: number, b1: number): P2[] => [[a0, b0], [a1, b0], [a1, b1], [a0, b1]];
  // Outside: bottom, top (round the pocket), the four walls (screw holes in X- and Y-).
  face(rect(x0, y0, x1, y1), [], ([x, y]) => [x, y, zb], [0, 0, -1]);
  face(rect(x0, y0, x1, y1), [rect(px0, py0, px1, py1)], ([x, y]) => [x, y, zt], [0, 0, 1]);
  face(rect(y0, zb, y1, zt), xHoles, ([y, z]) => [x0, y, z], [-1, 0, 0]);
  face(rect(y0, zb, y1, zt), [], ([y, z]) => [x1, y, z], [1, 0, 0]);
  face(rect(x0, zb, x1, zt), yHoles, ([x, z]) => [x, y0, z], [0, -1, 0]);
  face(rect(x0, zb, x1, zt), [], ([x, z]) => [x, y1, z], [0, 1, 0]);
  // The pocket: its floor and walls (facing into it), the screws coming through X- and Y-.
  face(rect(px0, py0, px1, py1), [], ([x, y]) => [x, y, zp], [0, 0, 1]);
  face(rect(py0, zp, py1, zt), xHoles, ([y, z]) => [px0, y, z], [1, 0, 0]);
  face(rect(py0, zp, py1, zt), [], ([y, z]) => [px1, y, z], [-1, 0, 0]);
  face(rect(px0, zp, px1, zt), yHoles, ([x, z]) => [x, py0, z], [0, 1, 0]);
  face(rect(px0, zp, px1, zt), [], ([x, z]) => [x, py1, z], [0, -1, 0]);
  // The holes' sides, facing their axis.
  const side = (h: P2[], at: (s: number, p: P2) => Vec, axis: (s: number) => Vec) => {
    for (let k = 0; k < SEGMENTS; k++) {
      const [p, q] = [h[k], h[(k + 1) % SEGMENTS]];
      const [a, b, cc, dd] = [at(0, p), at(1, p), at(1, q), at(0, q)];
      const mid: Vec = [(a[0] + cc[0]) / 2, (a[1] + cc[1]) / 2, (a[2] + cc[2]) / 2];
      const n = sub(axis(0.5), mid);
      for (const [u, v, w] of [[a, b, cc], [a, cc, dd]]) out.push(...(dot(cross(sub(v, u), sub(w, u)), n) >= 0 ? [...u, ...v, ...w] : [...u, ...w, ...v]));
    }
  };
  xHoles.forEach((h, i) => side(h, (s, [y, z]) => [s ? px0 : x0, y, z], () => [(x0 + px0) / 2, screws.filter((t) => t.face === 'X-')[i].at[1], zs]));
  yHoles.forEach((h, i) => side(h, (s, [x, z]) => [x, s ? py0 : y0, z], () => [screws.filter((t) => t.face === 'Y-')[i].at[0], (y0 + py0) / 2, zs]));
  return { size: [x1 - x0, y1 - y0, zt - zb], min: [x0, y0, zb], pocket: { lo: [px0, py0], hi: [px1, py1], depth: d }, screws, tris: new Float32Array(out) };
}
