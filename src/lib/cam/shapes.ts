/*
 * What the part is made of, named as the shop says it (you, Beta 2: item 4): its holes (through, blind, a counterbore
 * over a hole, a likely thread by its tap drill), the floors under its top, its chamfers, rounded edges and 3D
 * surfaces, found on the model from its six sides, each once, alike ones counted together. Read only: the planner
 * finds the same features itself (features.ts); this names them for the designer.
 */
import { cylinders, SIDES, sideFeatures, toModel } from './features';
import { turnTris } from './geom';

export type ShapeKind = 'throughHole' | 'blindHole' | 'counterbore' | 'tapped' | 'floor' | 'chamfer' | 'round' | 'surface';

export interface Shape {
  kind: ShapeKind;
  /** How many alike. */
  count: number;
  /** Ø of a hole or counterbore, radius of a rounded edge (mm). */
  d?: number;
  r?: number;
  /** How deep (a hole, a counterbore, a floor under the top; mm). */
  depth?: number;
  /** A likely thread (the hole has its tap drill's Ø): "M6". */
  thread?: string;
  /** The side it is reached from (the model's: Z+, X-...). */
  side: string;
  /** Area (mm²) of a chamfer, a floor or the 3D surfaces. */
  area?: number;
}

/** ISO metric coarse threads by their tap drill (mm). */
const TAP_DRILLS: [number, string][] = [
  [1.6, 'M2'],
  [2.05, 'M2.5'],
  [2.5, 'M3'],
  [3.3, 'M4'],
  [4.2, 'M5'],
  [5, 'M6'],
  [6.8, 'M8'],
  [8.5, 'M10'],
  [10.2, 'M12'],
  [14, 'M16'],
];
const threadOf = (d: number) => TAP_DRILLS.find(([t]) => Math.abs(t - d) < 0.06)?.[1];
const r2 = (v: number) => Math.round(v * 100) / 100;

/** The shop's own word for each (you: side by side with the page's, in grey). */
export const FRENCH: Record<ShapeKind, string> = {
  throughHole: 'trou débouchant',
  blindHole: 'trou borgne',
  counterbore: 'lamage',
  tapped: 'taraudage ?',
  floor: 'fond',
  chamfer: 'chanfrein',
  round: 'arrondi',
  surface: 'surface 3D',
};

export function recognize(tris: ArrayLike<number>): Shape[] {
  const feats = SIDES.map((s) => sideFeatures(tris, s));
  // Holes in the model's frame: axis, a point on it, Ø, depth; a through hole is seen from both its ends (once here).
  // span: from where to where along its axis (the model's coordinate), bottom: its inner end there.
  const holes: { axis: number; at: number[]; d: number; depth: number; through: boolean; side: string; span: [number, number]; bottom: number }[] = [];
  for (const f of feats) {
    const axis = f.R.slice(6, 9).findIndex((v) => v !== 0);
    for (const h of f.holes) {
      const p = toModel(f, [h.c[0], h.c[1], 0]);
      const at = p.map((v, k) => (k === axis ? 0 : r2(v)));
      if (holes.some((o) => o.axis === axis && o.at.every((v, k) => Math.abs(v - at[k]) < 0.05) && Math.abs(o.d - 2 * h.r) < 0.05 && (o.through || h.through))) continue;
      const [a, b] = [toModel(f, [h.c[0], h.c[1], h.top])[axis], toModel(f, [h.c[0], h.c[1], h.bottom])[axis]];
      holes.push({ axis, at, d: r2(2 * h.r), depth: r2(h.top - h.bottom), through: h.through, side: f.side, span: [Math.min(a, b), Math.max(a, b)], bottom: b });
    }
  }
  // A hole that opens into a wider one on its axis (a counterbore from the other face) goes through the part.
  for (const h of holes)
    if (!h.through && holes.some((o) => o !== h && o.axis === h.axis && o.d > h.d + 0.05 && o.at.every((v, k) => Math.abs(v - h.at[k]) < 0.05) && o.span.some((v) => Math.abs(v - h.bottom) < 0.06))) h.through = true;
  const out: Shape[] = [];
  const add = (s: Omit<Shape, 'count'>) => {
    const same = out.find((o) => o.kind === s.kind && o.d === s.d && o.r === s.r && o.thread === s.thread && Math.abs((o.depth ?? 0) - (s.depth ?? 0)) < 0.05);
    if (same) same.count++;
    else out.push({ ...s, count: 1 });
  };
  for (const h of holes) {
    // A counterbore: a wider hole on the axis of a narrower one that goes on from its bottom (seen from either side).
    const inner = !h.through && holes.find((o) => o !== h && o.axis === h.axis && o.d < h.d - 0.05 && o.at.every((v, k) => Math.abs(v - h.at[k]) < 0.05) && o.span.some((v) => Math.abs(v - h.bottom) < 0.06));
    if (inner) {
      add({ kind: 'counterbore', d: h.d, depth: h.depth, side: h.side });
      continue;
    }
    const thread = threadOf(h.d);
    add({ kind: thread ? 'tapped' : h.through ? 'throughHole' : 'blindHole', d: h.d, depth: h.depth, side: h.side, ...(thread ? { thread } : {}) });
  }
  // Floors under the top (pockets and steps) from the part's two main faces, across its thinnest size (seen from the other
  // sides, the walls of pockets and holes would read as floors); chamfers, rounded edges, 3D surfaces.
  const ext = [0, 1, 2].map((k) => Math.max(...feats.map((f) => toModel(f, f.max)[k])) - Math.min(...feats.map((f) => toModel(f, f.min)[k])));
  const thin = ext.indexOf(Math.min(...ext.map(Math.abs)));
  for (const f of feats) {
    if (f.R.slice(6, 9).findIndex((v) => v !== 0) === thin)
      for (const fl of f.floors) if (fl.z < f.max[2] - 0.05 && fl.z > f.min[2] + 0.05 && fl.area > 1) add({ kind: 'floor', depth: r2(f.max[2] - fl.z), side: f.side, area: Math.round(fl.area) });
    for (const c of f.chamfers) add({ kind: 'chamfer', depth: r2(c.hi - c.lo), side: f.side, area: Math.round(c.area) });
  }
  // Each chamfer is seen from two sides (a 45° face): once, from the side that sees it first.
  const seen = new Set<string>();
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].kind !== 'chamfer') continue;
    const k = `${out[i].depth}|${out[i].area}`;
    if (seen.has(k)) out.splice(i, 1);
    seen.add(k);
  }
  // Rounded edges: the outside rounded (a part of a cylinder bulging out, not a whole pin), along Z only (shortcut: the
  // other axes' edges are named from their own sides once the recognizer needs them; the planner does not use this).
  const P = turnTris(tris, feats[0].R);
  for (const c of cylinders(P)) if (!c.concave && !c.closed && c.r <= 10) add({ kind: 'round', r: r2(c.r), side: feats[0].side });
  const free = Math.round(Math.max(...feats.map((f) => f.freeform)));
  if (free > 5) out.push({ kind: 'surface', count: 1, side: feats[feats.findIndex((f) => Math.round(f.freeform) === free)].side, area: free });
  const order: ShapeKind[] = ['throughHole', 'tapped', 'blindHole', 'counterbore', 'floor', 'chamfer', 'round', 'surface'];
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || (b.d ?? 0) - (a.d ?? 0) || (a.depth ?? 0) - (b.depth ?? 0));
}
