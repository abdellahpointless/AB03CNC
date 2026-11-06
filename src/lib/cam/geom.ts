import ClipperLib, { type Path, type Paths } from 'clipper-lib';
import type { Vec } from '../toolpath';
import { apply, type Mat3 } from '../orient';

/*
 * Geometry for CAM AI: the part's model cut into outlines at a height (exact, from its triangles),
 * and outline operations (union, difference, offset by a tool radius) done in whole microns by
 * Clipper, the standard polygon library of CAM software.
 */

/** Outline coordinates are kept in µm. */
export const SCALE = 1000;
export type P2 = [number, number];
/** Closed outlines (outer ones counter-clockwise, holes clockwise), in mm. */
export type Region = P2[][];

const toPaths = (r: Region): Paths => r.map((loop) => loop.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) })));
const fromPaths = (p: Paths): Region => p.map((loop) => loop.map((q) => [q.X / SCALE, q.Y / SCALE] as P2));

function clip(type: number, a: Region, b: Region, fill = ClipperLib.PolyFillType.pftNonZero): Region {
  const c = new ClipperLib.Clipper();
  c.AddPaths(toPaths(a), ClipperLib.PolyType.ptSubject, true);
  if (b.length) c.AddPaths(toPaths(b), ClipperLib.PolyType.ptClip, true);
  const out: Paths = [];
  c.Execute(type, out, fill, fill);
  return fromPaths(out);
}
export const union = (a: Region, b: Region = []) => clip(ClipperLib.ClipType.ctUnion, a, b);
export const difference = (a: Region, b: Region) => clip(ClipperLib.ClipType.ctDifference, a, b);
export const intersection = (a: Region, b: Region) => clip(ClipperLib.ClipType.ctIntersection, a, b);
/** Loops that may overlap or nest, read even-odd (a slice of a mesh), as clean outlines. */
export const evenOdd = (a: Region) => clip(ClipperLib.ClipType.ctUnion, a, [], ClipperLib.PolyFillType.pftEvenOdd);

/** Grown (d > 0) or shrunk (d < 0) by d mm, round corners (what a round tool leaves). */
export function offset(r: Region, d: number): Region {
  if (!r.length) return [];
  const o = new ClipperLib.ClipperOffset(2, 0.002 * SCALE);
  o.AddPaths(toPaths(r), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
  const out: Paths = [];
  o.Execute(out, d * SCALE);
  return fromPaths(out);
}

export const area = (r: Region) => r.reduce((t, loop) => t + ClipperLib.Clipper.Area(toPaths([loop])[0]), 0) / (SCALE * SCALE);
export const rect = (x0: number, y0: number, x1: number, y1: number): Region => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]];
/** Inside a region (holes counted): 1 inside, 0 outside, -1 on an edge. */
export function inside(r: Region, [x, y]: P2): number {
  let n = 0;
  for (const p of toPaths(r)) {
    const v = ClipperLib.Clipper.PointInPolygon({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }, p as Path);
    if (v === -1) return -1;
    n += v;
  }
  return n % 2;
}

/** The triangles (9 numbers each) turned by R: the model as it lies in a setup. */
export function turnTris(tris: ArrayLike<number>, R: Mat3, t: Vec = [0, 0, 0]): Float32Array {
  const out = new Float32Array(tris.length);
  for (let i = 0; i < tris.length; i += 3) {
    const q = apply(R, [tris[i], tris[i + 1], tris[i + 2]]);
    out[i] = q[0] + t[0];
    out[i + 1] = q[1] + t[1];
    out[i + 2] = q[2] + t[2];
  }
  return out;
}

export function bounds(tris: ArrayLike<number>): { min: Vec; max: Vec } {
  const min: Vec = [Infinity, Infinity, Infinity];
  const max: Vec = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], tris[i + k]);
      max[k] = Math.max(max[k], tris[i + k]);
    }
  return { min, max };
}

/**
 * The part cut at height z: its material there as outlines. The plane is moved a hair off any
 * vertex height so that faces lying in it do not count twice.
 */
export function slice(tris: ArrayLike<number>, z0: number): Region {
  let z = z0;
  for (let tries = 0; tries < 5; tries++) {
    let hit = false;
    for (let i = 2; i < tris.length; i += 3) if (Math.abs(tris[i] - z) < 1e-6) hit = true;
    if (!hit) break;
    z += 2e-5;
  }
  const segs: [P2, P2][] = [];
  for (let i = 0; i < tris.length; i += 9) {
    const p = [0, 3, 6].map((o) => [tris[i + o], tris[i + o + 1], tris[i + o + 2]] as Vec);
    const above = p.map((q) => q[2] > z);
    const n = above.filter(Boolean).length;
    if (n === 0 || n === 3) continue;
    const pts: P2[] = [];
    for (let a = 0; a < 3; a++) {
      const b = (a + 1) % 3;
      if (above[a] === above[b]) continue;
      const t = (z - p[a][2]) / (p[b][2] - p[a][2]);
      pts.push([p[a][0] + t * (p[b][0] - p[a][0]), p[a][1] + t * (p[b][1] - p[a][1])]);
    }
    if (pts.length === 2) segs.push([pts[0], pts[1]]);
  }
  // Chain the pieces into loops by their ends.
  const key = ([x, y]: P2) => `${Math.round(x * 1e5)},${Math.round(y * 1e5)}`;
  const from = new Map<string, number[]>();
  segs.forEach(([a], i) => (from.get(key(a)) ?? from.set(key(a), []).get(key(a))!).push(i));
  const to = new Map<string, number[]>();
  segs.forEach(([, b], i) => (to.get(key(b)) ?? to.set(key(b), []).get(key(b))!).push(i));
  const used = new Uint8Array(segs.length);
  const loops: P2[][] = [];
  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const loop: P2[] = [segs[s][0], segs[s][1]];
    for (;;) {
      const end = key(loop[loop.length - 1]);
      // Triangles may wind either way: follow a piece starting or ending here.
      let next = (from.get(end) ?? []).find((i) => !used[i]);
      let flip = false;
      if (next === undefined) {
        next = (to.get(end) ?? []).find((i) => !used[i]);
        flip = true;
      }
      if (next === undefined) break;
      used[next] = 1;
      loop.push(flip ? segs[next][0] : segs[next][1]);
    }
    if (loop.length > 3) loops.push(loop);
  }
  return evenOdd(loops);
}
