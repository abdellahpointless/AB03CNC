import type { Vec } from '../toolpath';
import { ALL, apply, mul, transpose, type Mat3 } from '../orient';
import { area, bounds, difference, intersection, offset, slice, turnTris, union, type P2, type Region } from './geom';
import { filled } from './clear';

/*
 * What CAM AI finds on a part's model, seen from each side it can be machined from (the tool comes
 * down along the setup's Z): the heights of its flat floors, its round holes and bosses, its 45°
 * chamfers, and the faces that are none of these (3D surfaces, ball mill).
 */

/** Model directions a tool can come from (the side of the part facing up in a setup). */
export const SIDES: { name: string; d: Vec }[] = [
  { name: 'Z+', d: [0, 0, 1] },
  { name: 'Z-', d: [0, 0, -1] },
  { name: 'X+', d: [1, 0, 0] },
  { name: 'X-', d: [-1, 0, 0] },
  { name: 'Y+', d: [0, 1, 0] },
  { name: 'Y-', d: [0, -1, 0] },
];

/** A quarter turn about the vertical: the part's X and Y swapped in the vise. */
export const SPIN: Mat3 = [0, -1, 0, 1, 0, 0, 0, 0, 1];

/** The turn that puts model direction d up (+Z), the smallest such turn. */
export function upTurn(d: Vec): Mat3 {
  const fits = ALL.filter((R) => {
    const v = apply(R, d);
    return v[2] === 1;
  });
  // Fewest axes moved: largest trace.
  return fits.sort((a, b) => b[0] + b[4] + b[8] - (a[0] + a[4] + a[8]))[0];
}

export interface Hole {
  /** Axis centre (setup X, Y), radius, top and bottom (setup Z). */
  c: [number, number];
  r: number;
  top: number;
  bottom: number;
  /** Goes through the part (from this side). */
  through: boolean;
  /** Wall all round (not opened into an edge or a pocket). */
  closed: boolean;
}

export interface SideFeatures {
  side: string;
  /** Model -> setup frame: p' = R p (setup Z up). */
  R: Mat3;
  /** Part extent in the setup frame. */
  min: Vec;
  max: Vec;
  /** Heights of flat floors facing up (highest first), with their area (mm²). */
  floors: { z: number; area: number }[];
  /** Round holes reachable from this side (open towards +Z). */
  holes: Hole[];
  /** 45° chamfer bands facing up: from height lo to hi (width hi - lo). */
  chamfers: { lo: number; hi: number; area: number }[];
  /** Area of faces facing up that are flat, a wall or 45° to no axis at all (3D surfaces, ball mill). */
  freeform: number;
}

const norm = (P: ArrayLike<number>, i: number): Vec => {
  const e1: Vec = [P[i + 3] - P[i], P[i + 4] - P[i + 1], P[i + 5] - P[i + 2]];
  const e2: Vec = [P[i + 6] - P[i], P[i + 7] - P[i + 1], P[i + 8] - P[i + 2]];
  const n: Vec = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  const l = Math.hypot(n[0], n[1], n[2]);
  return l ? [n[0] / l, n[1] / l, n[2] / l] : [0, 0, 0];
};
const triArea = (P: ArrayLike<number>, i: number) => {
  const e1 = [P[i + 3] - P[i], P[i + 4] - P[i + 1], P[i + 5] - P[i + 2]];
  const e2 = [P[i + 6] - P[i], P[i + 7] - P[i + 1], P[i + 8] - P[i + 2]];
  return Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]) / 2;
};

/**
 * Round vertical walls (axis along Z) of triangles already in the setup frame: smooth patches of
 * vertical facets, a circle fitted through their corners. Holes (material outside the circle)
 * and bosses (inside) are both returned, holes with concave = true.
 */
export function cylinders(P: Float32Array): { c: [number, number]; r: number; lo: number; hi: number; concave: boolean; closed: boolean; err: number }[] {
  const n = P.length / 9;
  const normals = Array.from({ length: n }, (_, t) => norm(P, t * 9));
  const vertical = normals.map((v) => Math.abs(v[2]) < 0.05 && (v[0] || v[1]));
  const key = (i: number) => `${Math.round(P[i] * 1000)},${Math.round(P[i + 1] * 1000)},${Math.round(P[i + 2] * 1000)}`;
  const at = new Map<string, number[]>();
  for (let t = 0; t < n; t++) if (vertical[t]) for (let c = 0; c < 3; c++) (at.get(key(t * 9 + c * 3)) ?? at.set(key(t * 9 + c * 3), []).get(key(t * 9 + c * 3))!).push(t);
  const seen = new Uint8Array(n);
  const out: ReturnType<typeof cylinders> = [];
  for (let s = 0; s < n; s++) {
    if (!vertical[s] || seen[s]) continue;
    // A smooth patch: neighbours bending less than 40° and not flat to each other for long.
    const list = [s];
    seen[s] = 1;
    for (let q = 0; q < list.length; q++) {
      const a = normals[list[q]];
      for (let c = 0; c < 3; c++)
        for (const t of at.get(key(list[q] * 9 + c * 3)) ?? []) {
          if (seen[t]) continue;
          const b = normals[t];
          if (a[0] * b[0] + a[1] * b[1] < 0.76) continue;
          seen[t] = 1;
          list.push(t);
        }
    }
    // Directions of the normals in the patch: a wall bending all round (no gap over 50°), or at
    // least a third of the way round.
    const ang = [...new Set(list.map((t) => Math.round(Math.atan2(normals[t][1], normals[t][0]) * 1000) / 1000))].sort((a, b) => a - b);
    const gaps = ang.map((v, i) => (i ? v - ang[i - 1] : v + 2 * Math.PI - ang[ang.length - 1]));
    const widest = Math.max(...gaps);
    if (2 * Math.PI - widest < (2 * Math.PI) / 3) continue;
    // Circle through the corners (least squares).
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0, m = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (const t of list)
      for (let c = 0; c < 3; c++) {
        const i = t * 9 + c * 3;
        const x = P[i], y = P[i + 1], z = -(x * x + y * y);
        sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z; m++;
        lo = Math.min(lo, P[i + 2]);
        hi = Math.max(hi, P[i + 2]);
      }
    const A = [sxx, sxy, sx, sxy, syy, sy, sx, sy, m];
    const det3 = (q: number[]) => q[0] * (q[4] * q[8] - q[5] * q[7]) - q[1] * (q[3] * q[8] - q[5] * q[6]) + q[2] * (q[3] * q[7] - q[4] * q[6]);
    const d = det3(A);
    if (Math.abs(d) < 1e-9) continue;
    const rhs = [sxz, syz, sz];
    const sol = [0, 1, 2].map((col) => det3(A.map((v, i) => (i % 3 === col ? rhs[Math.floor(i / 3)] : v))) / d);
    const cx = -sol[0] / 2;
    const cy = -sol[1] / 2;
    const r = Math.sqrt(Math.max(0, cx * cx + cy * cy - sol[2]));
    if (!(r > 0.1)) continue;
    let err = 0;
    let concave = 0;
    for (const t of list) {
      for (let c = 0; c < 3; c++) {
        const i = t * 9 + c * 3;
        err = Math.max(err, Math.abs(Math.hypot(P[i] - cx, P[i + 1] - cy) - r));
      }
      // A hole's walls face its axis (the material is outside).
      const i = t * 9;
      const mx = (P[i] + P[i + 3] + P[i + 6]) / 3 - cx;
      const my = (P[i + 1] + P[i + 4] + P[i + 7]) / 3 - cy;
      concave += normals[t][0] * mx + normals[t][1] * my < 0 ? 1 : -1;
    }
    if (err > Math.max(0.02, r * 0.03)) continue;
    out.push({ c: [cx, cy], r, lo, hi, concave: concave > 0, closed: widest < (50 * Math.PI) / 180, err });
  }
  return out;
}

/** The part seen from one side: everything a setup with that side up can machine. */
export function sideFeatures(tris: ArrayLike<number>, side: (typeof SIDES)[number], spin = false): SideFeatures {
  const R = spin ? mul(SPIN, upTurn(side.d)) : upTurn(side.d);
  const P = turnTris(tris, R);
  const { min, max } = bounds(P);
  const floors = new Map<number, number>();
  const chamfers = new Map<string, { lo: number; hi: number; area: number }>();
  let freeform = 0;
  for (let i = 0; i < P.length; i += 9) {
    const nv = norm(P, i);
    const nz = nv[2];
    const a = triArea(P, i);
    if (nz > 0.999) {
      const z = Math.round(((P[i + 2] + P[i + 5] + P[i + 8]) / 3) * 200) / 200;
      floors.set(z, (floors.get(z) ?? 0) + a);
    } else if (nz > 0.69 && nz < 0.72) {
      const lo = Math.round(Math.min(P[i + 2], P[i + 5], P[i + 8]) * 100) / 100;
      const hi = Math.round(Math.max(P[i + 2], P[i + 5], P[i + 8]) * 100) / 100;
      const k = `${lo}:${hi}`;
      const c = chamfers.get(k) ?? chamfers.set(k, { lo, hi, area: 0 }).get(k)!;
      c.area += a;
    } else if (nz > 0.02 && nv.every((c) => Math.abs(c) > 0.02 && Math.abs(Math.abs(c) - Math.SQRT1_2) > 0.01)) {
      // Not a wall or a chamfer along any axis (those are machined from another side): a 3D surface.
      freeform += a;
    }
  }
  // Holes reachable from above: nothing of the part over their whole circle (a wider bore under a
  // narrower neck is not: its tool would cut the neck away), at every floor above and just over
  // the hole's top.
  const above = [...new Set([...floors.keys(), max[2]])].sort((a, b) => b - a);
  const cuts = new Map<number, ReturnType<typeof slice>>();
  const cut = (z: number) => cuts.get(z) ?? cuts.set(z, slice(P, z)).get(z)!;
  const disk = (c: [number, number], r: number): P2[][] => [Array.from({ length: 32 }, (_, i) => [c[0] + r * Math.cos((i * Math.PI) / 16), c[1] + r * Math.sin((i * Math.PI) / 16)] as P2)];
  const open = (h: { c: [number, number]; r: number; hi: number }) =>
    [...above.filter((z) => z > h.hi + 0.06).map((z) => z - 0.01), ...(h.hi + 0.05 < max[2] ? [h.hi + 0.05] : [])].every((z) => area(intersection(cut(z), disk(h.c, h.r - 0.05))) < 0.01);
  const holes: Hole[] = cylinders(P)
    .filter((h) => h.concave && open(h))
    .map((h) => ({ c: h.c, r: h.r, top: h.hi, bottom: h.lo, through: h.lo <= min[2] + 0.01, closed: h.closed }));
  return {
    side: side.name,
    R,
    min,
    max,
    floors: [...floors].map(([z, area]) => ({ z, area })).sort((a, b) => b.z - a.z),
    holes,
    chamfers: [...chamfers.values()].filter((c) => c.area > 0.5),
    freeform,
  };
}

/** Back from a setup frame to the model's. */
export const toModel = (f: SideFeatures, p: Vec) => apply(transpose(f.R), p);

/**
 * Lettering cut into the face on top (a top plate's engraving), in a setup frame: grooves open at
 * the top, at most 1 mm deep and 2 mm wide (nothing of them over 1 mm from their edge; wider
 * recesses are pockets for the end mills). Each with its floor's depth, from the face's own floors.
 */
export function engravings(P: Float32Array, top: number, floors: number[]): { depth: number; region: Region }[] {
  const surface = slice(P, top - 0.005);
  const open = difference(filled(surface), surface);
  if (area(open) < 0.02) return [];
  const narrow = difference(open, offset(offset(open, -1), 1.02));
  const out: { depth: number; region: Region }[] = [];
  let floored: Region = [];
  for (const d of floors.map((z) => top - z).filter((d) => d > 0.004 && d <= 1.0001).sort((a, b) => a - b)) {
    // Narrow grooves with material just under this depth: their floor is here (or above, done).
    const now = intersection(narrow, slice(P, top - d - 0.005));
    const here = difference(now, floored);
    if (area(here) > 0.02) out.push({ depth: Math.round(d * 1000) / 1000, region: here });
    floored = union(floored, now);
  }
  return out;
}

