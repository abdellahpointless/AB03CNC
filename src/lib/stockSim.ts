import type { Toolpath, Vec } from './toolpath';
import type { Mat3 } from './orient';
import type { ProgramSetups } from './setups';
import { movePath, runShares } from './playback';

/*
 * The part as a fine grid of sample points in its own frame. Every cutting move takes away the
 * points the tool sweeps through; each point remembers which move took it away and how far along
 * that move the tool was when it first reached it, so the part can be shown at any instant of the
 * program (the cut follows the tool continuously) without cutting again.
 *
 * The surface is not drawn as little cubes: where solid meets cut, the exact edge of the tool
 * that cut it is found (and which way it faces), and a surface is fitted through those points
 * (dual contouring). Flat faces stay flat, corners stay sharp, round walls are round.
 *
 * Tools point down (−Z on the machine). End mills are flat-bottomed cylinders; pointed tools have
 * a cone tip: chamfer tools (STICHEL / FASE, 45° per side or the angle in their code), spot drills
 * (ZENTRIER / ANBOHR, 90° point) and drills (118° point). Rapid moves do not cut.
 */

export const KEPT = 0x7fffffff;
/**
 * Instants of the program as whole numbers: move index × SUB + the share of that move done
 * (0..SUB). The mesher shows the part at such an instant.
 */
export const SUB = 1024;
/** The instant `pos` (moves done, with the share of the current move) as a whole number. */
export const instant = (pos: number) => Math.max(0, Math.floor(pos * SUB));
/** How long the part takes to turn between setups in the 3D view (ms). */
export const FLIP_MS = 2200;

export interface SimTool {
  tool: number | null;
  radius: number;
  /** Pointed tip: how fast the radius grows per mm above the tip (tan of half the point angle); 'drop': the eyedrop ball cutter; null = flat. */
  slope: number | 'drop' | null;
}

export interface SimInput {
  /** Cutting moves as polylines (machine coordinates of their setup). */
  moves: { setup: number; tool: number | null; points: Vec[] }[];
  setups: { orient: Mat3; offset: Vec }[];
  part: { min: Vec; max: Vec };
  tools: SimTool[];
  /** Upper limit of sample points (memory and time). */
  maxVoxels?: number;
  /** Also find, on the finished surface, the move reaching furthest past each sample (for drawing it); default on. */
  surfaceMoves?: boolean;
}

export interface Grid {
  n: [number, number, number];
  /** Spacing of the sample points along X, Y, Z (they fill the part box exactly). */
  step: Vec;
  /** Average spacing. */
  size: number;
  origin: Vec;
  /** Move that first cut each sample (KEPT: never cut). */
  removed: Int32Array;
  /** How far along that move (0..65535 = start..end) the tool was when it reached the sample. */
  share: Uint16Array;
  /** Cut samples on the finished surface: the move reaching furthest past them, when not the first. */
  outer?: Map<number, number>;
}


/** Moves of a parsed program, ready to cut (drilling becomes a straight plunge). */
export function simMoves(tp: Toolpath): SimInput['moves'] {
  return tp.moves.map((m) => ({ setup: m.setup, tool: m.tool, points: m.kind === 'rapid' ? [] : movePath(m) }));
}

export function simTools(tp: Toolpath): SimTool[] {
  return tp.tools.map((t) => ({
    tool: t.tool,
    radius: Math.max(0.3, (t.diameter ?? guessDiameter(t.label)) / 2),
    slope: tipSlope(t.label) ?? (isBall(t.label) ? 'drop' : null),
  }));
}

/** Ball cutters (fraise boule, KUGEL, BALL): drawn and cut as an eyedrop. */
export const isBall = (label: string) => /KUGEL|BALL|BOULE|HEMISPH|\bKF_|\bKU_/i.test(label);

// The eyedrop cutter, in ball radii: a ball, then a taper tangent to it up into a thinner neck.
const DROP_NECK = 0.55;
export const DROP_TOP = 2.4;
const DROP_PHI = Math.atan2(DROP_TOP - 1, DROP_NECK) - Math.acos(1 / Math.hypot(DROP_NECK, DROP_TOP - 1));
const DROP_TX = Math.cos(DROP_PHI);
const DROP_TY = 1 + Math.sin(DROP_PHI);
/** Radius of the eyedrop cutter (ball radius r) at height h above its tip; -1 below the tip. */
export function dropRadius(h: number, r: number): number {
  const u = h / r;
  if (u < 0) return -1;
  if (u <= DROP_TY) return r * Math.sqrt(Math.max(0, 1 - (1 - u) * (1 - u)));
  if (u <= DROP_TOP) return r * (DROP_TX + ((u - DROP_TY) / (DROP_TOP - DROP_TY)) * (DROP_NECK - DROP_TX));
  return r * DROP_NECK;
}

/** tan(half point angle) of a pointed tool, from its name; null for flat end mills and taps. */
export function tipSlope(label: string): number | null {
  const l = label.toUpperCase();
  const half = (deg: number) => Math.tan((deg * Math.PI) / 180);
  if (/GEWINDE|REIBAHLE|\bGB_|\bRA_/.test(l)) return null;
  if (/STICHEL|FASE|SENKER|CHAMFER|CHANFREIN|ANFAS|ENTGRAT|KEGEL|\bST_/.test(l)) {
    // "ST_04.00_025_G45": 45° per side. "90 GRAD STICHEL": 90° point.
    const code = l.match(/_G(\d{2})(?:_|\b)/);
    if (code) return half(Number(code[1]));
    const point = l.match(/(\d{2,3})\s*(?:GRAD|°)/);
    return half(point ? Number(point[1]) / 2 : 45);
  }
  if (/ZENTRIER|ANBOHR|NC-ANB|SPOT|POINTEUR|\bZB_|\bNC_/.test(l)) return half(45);
  if (/BOHRER|BOHREN|\bSB_|DRILL|\bFORET/.test(l)) return half(59);
  return null;
}

/** "4.2MM BOHRER", "D10", "FRAESER 8" → a diameter, when the tool list has none. */
function guessDiameter(label: string): number {
  const m = label.match(/(\d+(?:[.,]\d+)?)\s*MM/i) ?? label.match(/\bD\s*(\d+(?:[.,]\d+)?)/i);
  return m ? Number(m[1].replace(',', '.')) : 6;
}

export function buildInput(tp: Toolpath, an: ProgramSetups): SimInput | null {
  if (!an.part) return null;
  return {
    moves: simMoves(tp),
    setups: an.setups.map((s) => ({ orient: s.orient, offset: s.offset })),
    part: an.part,
    tools: simTools(tp),
  };
}

/* ---------- One tool sweep ---------- */

/**
 * Is machine point (x, y, z) inside what a tool sweeps moving from a to b?
 * Flat tool: the union of the tool's discs along the move, and everything above them. For each
 * point the deepest tool position that covers it counts, so plunges, ramps and helixes cut to
 * their full depth.
 */
export function sweeps(x: number, y: number, z: number, a: Vec, b: Vec, r: number, slope: number | 'drop' | null): boolean {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const wx = x - a[0];
  const wy = y - a[1];
  const l2 = dx * dx + dy * dy;
  if (slope === null) {
    const w2 = wx * wx + wy * wy;
    if (l2 < 1e-12) return w2 <= r * r && z >= Math.min(a[2], b[2]) - 1e-9;
    // Tool positions u (0..1) whose disc covers the point: |w - u d|² <= r².
    const bq = (wx * dx + wy * dy) / l2;
    const cq = (w2 - r * r) / l2;
    const disc = bq * bq - cq;
    if (disc < 0) return false;
    const sq = Math.sqrt(disc);
    const u1 = Math.max(0, bq - sq);
    const u2 = Math.min(1, bq + sq);
    if (u1 > u2) return false;
    return z >= a[2] + Math.min(u1 * dz, u2 * dz) - 1e-9;
  }
  if (slope === 'drop') {
    // A plunge: the widest the drop gets between where its tip starts and ends.
    if (l2 < 1e-12) {
      const h2 = z - Math.min(a[2], b[2]);
      if (h2 < -1e-9) return false;
      const h1 = Math.max(0, z - Math.max(a[2], b[2]));
      const w = h1 <= r && r <= h2 ? r : Math.max(dropRadius(h1, r), dropRadius(h2, r));
      return wx * wx + wy * wy <= w * w + 1e-9;
    }
    // Level: the drop's radius at this height, at the nearest point of the move. A ramp: along it.
    // shortcut: a ramp is checked at 17 points along it, fine for chords of arcs and short ramps; refine if long steep ramps show steps.
    const near = Math.min(1, Math.max(0, (wx * dx + wy * dy) / l2));
    const us = Math.abs(dz) < 1e-9 ? [near] : [near, ...Array.from({ length: 17 }, (_, i) => i / 16)];
    for (const u of us) {
      const ex = wx - u * dx;
      const ey = wy - u * dy;
      if (Math.sqrt(ex * ex + ey * ey) <= dropRadius(z - (a[2] + u * dz), r) + 1e-9) return true;
    }
    return false;
  }
  // Pointed tip: radius at height h above the tip is min(r, h · slope). Check the likely positions.
  const us = l2 < 1e-12 ? [dz < 0 ? 1 : 0] : [0, 1, Math.min(1, Math.max(0, (wx * dx + wy * dy) / l2))];
  for (const u of us) {
    const ex = wx - u * dx;
    const ey = wy - u * dy;
    const d = Math.sqrt(ex * ex + ey * ey);
    const h = z - (a[2] + u * dz);
    if (h >= -1e-9 && d <= Math.min(r, h * slope) + 1e-9) return true;
  }
  return false;
}

/**
 * When a tool moving from a to b first reaches machine point (x, y, z): the share u (0..1) of the
 * move, or -1 when it never does. Same rule as `sweeps`: the point goes once the tool's disc is
 * over it with its bottom at or below it.
 */
export function touch(x: number, y: number, z: number, a: Vec, b: Vec, r: number, slope: number | 'drop' | null): number {
  if (slope !== null) {
    if (!sweeps(x, y, z, a, b, r, slope)) return -1;
    // Pointed tip: the shares that reach the point form one stretch; find where it starts.
    let lo = 0;
    let hi = 1;
    const e: Vec = [0, 0, 0];
    for (let it = 0; it < 12; it++) {
      const mid = (lo + hi) / 2;
      e[0] = a[0] + (b[0] - a[0]) * mid;
      e[1] = a[1] + (b[1] - a[1]) * mid;
      e[2] = a[2] + (b[2] - a[2]) * mid;
      if (sweeps(x, y, z, a, e, r, slope)) hi = mid;
      else lo = mid;
    }
    return hi;
  }
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const wx = x - a[0];
  const wy = y - a[1];
  const l2 = dx * dx + dy * dy;
  const w2 = wx * wx + wy * wy;
  let u1 = 0;
  let u2 = 1;
  if (l2 < 1e-12) {
    if (w2 > r * r) return -1;
  } else {
    const bq = (wx * dx + wy * dy) / l2;
    const disc = bq * bq - (w2 - r * r) / l2;
    if (disc < 0) return -1;
    const sq = Math.sqrt(disc);
    u1 = Math.max(0, bq - sq);
    u2 = Math.min(1, bq + sq);
    if (u1 > u2) return -1;
  }
  // The tool bottom is at a.z + u·dz: the point goes once the bottom reaches it.
  if (dz >= 0) return z >= a[2] + u1 * dz - 1e-9 ? u1 : -1;
  const uz = (z - a[2] + 1e-9) / dz;
  if (uz > u2) return -1;
  return Math.max(u1, uz);
}

/**
 * How deep machine point (x, y, z) lies inside the tool moving from a to b where it passes closest:
 * the distance to the tool's edge there (sideways to its rim, or up from its bottom); 0 or less
 * when the tool does not reach it there.
 */
export function depthIn(x: number, y: number, z: number, a: Vec, b: Vec, r: number, slope: number | 'drop' | null): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const u = l2 > 1e-12 ? Math.min(1, Math.max(0, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : b[2] < a[2] ? 1 : 0;
  const d = Math.hypot(x - a[0] - u * dx, y - a[1] - u * dy);
  const h = z - (a[2] + u * (b[2] - a[2]));
  if (slope === 'drop') return h < 0 ? h : dropRadius(h, r) - d;
  return slope === null ? Math.min(r - d, h) : Math.min(r, h * slope) - d;
}

/** Which way the surface left by a sweep faces at machine point p (out of the material). */
function sweepNormal(p: Vec, a: Vec, b: Vec, r: number, slope: number | 'drop' | null, tol: number): Vec {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  // A plunge leaves the tool's shape where it ends (its tip at the bottom), as in sweeps.
  let u = l2 > 1e-12 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : b[2] < a[2] ? 1 : 0;
  u = Math.min(1, Math.max(0, u));
  const cx = a[0] + u * dx;
  const cy = a[1] + u * dy;
  let ix = cx - p[0];
  let iy = cy - p[1];
  const d = Math.hypot(ix, iy);
  if (d > 1e-9) {
    ix /= d;
    iy /= d;
  }
  if (slope === 'drop') {
    if (d < 1e-6) return [0, 0, 1];
    // Square to the drop's outline at this height: its radius grows by g per mm up.
    const h = p[2] - (a[2] + u * (b[2] - a[2]));
    const lo = Math.max(0, h - r * 1e-3);
    const hi = Math.max(lo + r * 1e-3, h + r * 1e-3);
    const g = (dropRadius(hi, r) - dropRadius(lo, r)) / (hi - lo);
    const n = Math.hypot(1, g);
    return [ix / n, iy / n, g / n];
  }
  if (slope !== null) {
    if (d < 1e-6) return [0, 0, 1];
    // Above the point the tool is a cylinder: a straight wall.
    const h = p[2] - (a[2] + u * (b[2] - a[2]));
    if (h * slope >= r - tol) return [ix, iy, 0];
    const n = Math.hypot(1, slope);
    return [ix / n, iy / n, slope / n];
  }
  // Bottom of the tool (the point is inside the disc, far from its rim): the floor faces up.
  if (d < r - tol || d < 1e-6) return [0, 0, 1];
  return [ix, iy, 0];
}

/* ---------- Cutting ---------- */

export function carve(input: SimInput, onProgress?: (share: number) => void): Grid {
  const { part } = input;
  const ext: Vec = [part.max[0] - part.min[0], part.max[1] - part.min[1], part.max[2] - part.min[2]];
  // About 0.55 mm on the largest top plates, finer on smaller parts: hole rims and small chamfers stay clean.
  const maxVoxels = input.maxVoxels ?? 5_000_000;
  const target = Math.max(0.12, Math.cbrt((ext[0] * ext[1] * ext[2]) / maxVoxels));
  const n: [number, number, number] = [Math.max(2, Math.round(ext[0] / target)), Math.max(2, Math.round(ext[1] / target)), Math.max(2, Math.round(ext[2] / target))];
  // Samples sit in the middle of equal slices of the part box, so its faces fall halfway between.
  const step: Vec = [ext[0] / n[0], ext[1] / n[1], ext[2] / n[2]];
  const origin: Vec = [...part.min];
  const removed = new Int32Array(n[0] * n[1] * n[2]).fill(KEPT);
  const share = new Uint16Array(n[0] * n[1] * n[2]);
  const toolOf = new Map(input.tools.map((t) => [t.tool, t]));
  const [nx, ny, nz] = n;

  /** Sample index range of the box a tool sweeps from a to b (machine coordinates of a setup). */
  const range = (s: { orient: Mat3; offset: Vec }, a: Vec, b: Vec, r: number): [number, number, number, number, number, number] | null => {
    const R = s.orient;
    const t = s.offset;
    const lo: Vec = [Math.min(a[0], b[0]) - r, Math.min(a[1], b[1]) - r, Math.min(a[2], b[2])];
    const hi: Vec = [Math.max(a[0], b[0]) + r, Math.max(a[1], b[1]) + r, 1e6];
    // Machine box -> part frame box (quarter turns keep boxes square to the axes).
    const pl: Vec = [Infinity, Infinity, Infinity];
    const ph: Vec = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 8; c++) {
      const m: Vec = [c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1], c & 4 ? hi[2] : lo[2]];
      const d: Vec = [m[0] - t[0], m[1] - t[1], m[2] - t[2]];
      const p: Vec = [R[0] * d[0] + R[3] * d[1] + R[6] * d[2], R[1] * d[0] + R[4] * d[1] + R[7] * d[2], R[2] * d[0] + R[5] * d[1] + R[8] * d[2]];
      for (let k = 0; k < 3; k++) {
        pl[k] = Math.min(pl[k], p[k]);
        ph[k] = Math.max(ph[k], p[k]);
      }
    }
    const i0 = Math.max(0, Math.floor((pl[0] - origin[0]) / step[0] - 0.5));
    const i1 = Math.min(nx - 1, Math.ceil((ph[0] - origin[0]) / step[0] - 0.5));
    const j0 = Math.max(0, Math.floor((pl[1] - origin[1]) / step[1] - 0.5));
    const j1 = Math.min(ny - 1, Math.ceil((ph[1] - origin[1]) / step[1] - 0.5));
    const k0 = Math.max(0, Math.floor((pl[2] - origin[2]) / step[2] - 0.5));
    const k1 = Math.min(nz - 1, Math.ceil((ph[2] - origin[2]) / step[2] - 0.5));
    return i0 > i1 || j0 > j1 || k0 > k1 ? null : [i0, i1, j0, j1, k0, k1];
  };

  // Every sample: the move that first reaches it, and how far along that move.
  input.moves.forEach((mv, index) => {
    if (onProgress && index % 500 === 0) onProgress((index / input.moves.length) * 0.85);
    if (mv.points.length < 2) return;
    const s = input.setups[mv.setup];
    if (!s) return;
    const R = s.orient;
    const t = s.offset;
    const tool = toolOf.get(mv.tool) ?? { tool: mv.tool, radius: 3, slope: null };
    const r = tool.radius;
    const run = runShares(mv.points);
    for (let q = 1; q < mv.points.length; q++) {
      const a = mv.points[q - 1];
      const b = mv.points[q];
      const s0 = run[q - 1];
      const ds = run[q] - s0;
      const box = range(s, a, b, r);
      if (!box) continue;
      const [i0, i1, j0, j1, k0, k1] = box;
      for (let k = k0; k <= k1; k++) {
        const pz = origin[2] + (k + 0.5) * step[2];
        for (let j = j0; j <= j1; j++) {
          const py = origin[1] + (j + 0.5) * step[1];
          let v = (k * ny + j) * nx + i0;
          for (let i = i0; i <= i1; i++, v++) {
            if (removed[v] !== KEPT) continue;
            const px = origin[0] + (i + 0.5) * step[0];
            const mx = R[0] * px + R[1] * py + R[2] * pz + t[0];
            const my = R[3] * px + R[4] * py + R[5] * pz + t[1];
            const mz = R[6] * px + R[7] * py + R[8] * pz + t[2];
            const u = touch(mx, my, mz, a, b, r, tool.slope);
            if (u < 0) continue;
            removed[v] = index;
            share[v] = Math.min(65535, Math.floor((s0 + u * ds) * 65536));
          }
        }
      }
    }
  });
  dropLoose(n, removed, share, (input.moves.length + 1) * SUB);

  // On the finished surface, also the move that reaches furthest past each cut sample. A later
  // pass that only skims a little more off (a finishing pass, a second circle a bit wider) may take
  // no sample of its own; without it the wall would be drawn where the earlier pass left it.
  let outer: Map<number, number> | undefined;
  if (input.surfaceMoves !== false) {
    const edge = new Uint8Array(removed.length);
    // Blocks of 8×8×8 samples holding surface samples: a sweep only looks into those.
    const bx = (nx + 7) >> 3;
    const by = (ny + 7) >> 3;
    const blocks = new Uint8Array(bx * by * ((nz + 7) >> 3));
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const v = (k * ny + j) * nx + i;
          if (removed[v] === KEPT) continue;
          if ((i > 0 && removed[v - 1] === KEPT) || (i < nx - 1 && removed[v + 1] === KEPT) || (j > 0 && removed[v - nx] === KEPT) || (j < ny - 1 && removed[v + nx] === KEPT) || (k > 0 && removed[v - nx * ny] === KEPT) || (k < nz - 1 && removed[v + nx * ny] === KEPT)) {
            edge[v] = 1;
            blocks[((k >> 3) * by + (j >> 3)) * bx + (i >> 3)] = 1;
          }
        }
    const best = new Int32Array(removed.length).fill(-1);
    const bestDepth = new Float32Array(removed.length);
    input.moves.forEach((mv, index) => {
      if (onProgress && index % 500 === 0) onProgress(0.85 + (index / input.moves.length) * 0.15);
      if (mv.points.length < 2) return;
      const s = input.setups[mv.setup];
      if (!s) return;
      const R = s.orient;
      const t = s.offset;
      const tool = toolOf.get(mv.tool) ?? { tool: mv.tool, radius: 3, slope: null };
      for (let q = 1; q < mv.points.length; q++) {
        const a = mv.points[q - 1];
        const b = mv.points[q];
        const box = range(s, a, b, tool.radius);
        if (!box) continue;
        const [i0, i1, j0, j1, k0, k1] = box;
        for (let kb = k0 >> 3; kb <= k1 >> 3; kb++)
          for (let jb = j0 >> 3; jb <= j1 >> 3; jb++)
            for (let ib = i0 >> 3; ib <= i1 >> 3; ib++) {
              if (!blocks[(kb * by + jb) * bx + ib]) continue;
              const ka = Math.max(k0, kb << 3);
              const kz = Math.min(k1, (kb << 3) + 7);
              const ja = Math.max(j0, jb << 3);
              const jz = Math.min(j1, (jb << 3) + 7);
              const ia = Math.max(i0, ib << 3);
              const iz = Math.min(i1, (ib << 3) + 7);
              for (let k = ka; k <= kz; k++) {
                const pz = origin[2] + (k + 0.5) * step[2];
                for (let j = ja; j <= jz; j++) {
                  const py = origin[1] + (j + 0.5) * step[1];
                  let v = (k * ny + j) * nx + ia;
                  for (let i = ia; i <= iz; i++, v++) {
                    // Only moves from the one that first cut it on can reach it.
                    if (!edge[v] || index < removed[v]) continue;
                    const px = origin[0] + (i + 0.5) * step[0];
                    const mx = R[0] * px + R[1] * py + R[2] * pz + t[0];
                    const my = R[3] * px + R[4] * py + R[5] * pz + t[1];
                    const mz = R[6] * px + R[7] * py + R[8] * pz + t[2];
                    const depth = depthIn(mx, my, mz, a, b, tool.radius, tool.slope);
                    if (depth > bestDepth[v] || best[v] < 0) {
                      bestDepth[v] = depth;
                      best[v] = index;
                    }
                  }
                }
              }
            }
      }
    });
    outer = new Map();
    for (let v = 0; v < best.length; v++) if (best[v] >= 0 && best[v] !== removed[v]) outer.set(v, best[v]);
  }
  onProgress?.(1);
  return { n, step, size: Math.cbrt(step[0] * step[1] * step[2]), origin, removed, share, outer };
}

/**
 * Material cut free from the part (a ring left round a contour, an offcut) falls away in the
 * machine: it goes at the instant the last bit holding it to the part is cut. The part is the
 * largest piece left at the end; a piece touching it, even at a corner (26 neighbours), stays.
 * Returns how many samples fell. `end`: an instant after the last move.
 */
export function dropLoose(n: [number, number, number], removed: Int32Array, share: Uint16Array, end: number): number {
  const [nx, ny, nz] = n;
  const inst = (v: number) => (removed[v] === KEPT ? Infinity : removed[v] * SUB + (share[v] >> 6));
  const label = new Int32Array(removed.length).fill(-1);
  const seen = new Int32Array(removed.length);
  const queue = new Int32Array(removed.length);
  let stamp = 0;
  // Breadth-first from v over samples that `pass`; stops (true) as soon as `stop` holds for one.
  const spread = (v: number, pass: (w: number) => boolean, reach: (w: number) => boolean | void): boolean => {
    stamp++;
    let head = 0;
    let tail = 0;
    queue[tail++] = v;
    seen[v] = stamp;
    if (reach(v)) return true;
    while (head < tail) {
      const c = queue[head++];
      const i = c % nx;
      const j = Math.floor(c / nx) % ny;
      const k = Math.floor(c / (nx * ny));
      for (let kk = Math.max(0, k - 1); kk <= Math.min(nz - 1, k + 1); kk++)
        for (let jj = Math.max(0, j - 1); jj <= Math.min(ny - 1, j + 1); jj++)
          for (let ii = Math.max(0, i - 1); ii <= Math.min(nx - 1, i + 1); ii++) {
            const w = (kk * ny + jj) * nx + ii;
            if (seen[w] === stamp || !pass(w)) continue;
            seen[w] = stamp;
            queue[tail++] = w;
            if (reach(w)) return true;
          }
    }
    return false;
  };
  // The pieces left at the end.
  const sizes: number[] = [];
  const seeds: number[] = [];
  for (let v = 0; v < removed.length; v++) {
    if (removed[v] !== KEPT || label[v] >= 0) continue;
    const c = sizes.length;
    let count = 0;
    spread(v, (w) => removed[w] === KEPT, (w) => {
      label[w] = c;
      count++;
    });
    sizes.push(count);
    seeds.push(v);
  }
  if (sizes.length < 2) return 0;
  const main = sizes.indexOf(Math.max(...sizes));
  let fell = 0;
  for (let c = 0; c < sizes.length; c++) {
    if (c === main || removed[seeds[c]] !== KEPT) continue;
    // Still held to the part at instant `at` (through material not cut yet)?
    const held = (at: number) => spread(seeds[c], (w) => inst(w) >= at, (w) => label[w] === main);
    let lo = 0;
    let hi = end;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (held(mid)) lo = mid;
      else hi = mid;
    }
    // Everything still joined to it then falls with it, just before that instant.
    const r = Math.floor((hi - 1) / SUB);
    const sh = ((hi - 1) % SUB) << 6;
    spread(seeds[c], (w) => inst(w) >= hi, (w) => {
      removed[w] = r;
      share[w] = sh;
      fell++;
    });
  }
  return fell;
}

/* ---------- Surfaces ---------- */

/**
 * How far the material left at move `before` reaches along a part axis (sign +1: its largest
 * coordinate, -1: its smallest), only where `keep(p)` holds when given. Exact to far below a voxel:
 * along the outermost layer of material, each voxel is bisected against the move that cut the
 * voxel beyond it (or reaches the raw face when nothing did).
 */
/**
 * Cutting moves of each setup binned by where they pass on the machine table (X/Y; a tool also
 * clears everything above it, so height does not narrow it down). Lets a point be tested against
 * only the moves that can reach it.
 */
interface MoveIndex {
  bins: { lo: [number, number]; cell: number; nx: number; ny: number; lists: Map<number, number[]> }[];
  /** Per move, on the machine: X and Y it reaches (tool radius included) and its lowest point. */
  reach: Float64Array;
}
const indexes = new WeakMap<SimInput, MoveIndex>();
function moveIndex(input: SimInput): MoveIndex {
  const known = indexes.get(input);
  if (known) return known;
  const radius = new Map(input.tools.map((t) => [t.tool, t.radius]));
  const reach = new Float64Array(input.moves.length * 5);
  input.moves.forEach((mv, i) => {
    const r = (radius.get(mv.tool) ?? 3) + 0.01;
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity, z = Infinity;
    for (const p of mv.points) { a = Math.min(a, p[0] - r); b = Math.min(b, p[1] - r); c = Math.max(c, p[0] + r); d = Math.max(d, p[1] + r); z = Math.min(z, p[2]); }
    reach.set([a, c, b, d, z - 0.01], i * 5);
  });
  const bins = input.setups.map((_, s) => {
    const own = input.moves.map((m, i) => (m.setup === s && m.points.length > 1 ? i : -1)).filter((i) => i >= 0);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const i of own) {
      const r = (radius.get(input.moves[i].tool) ?? 3) + 0.01;
      for (const p of input.moves[i].points) {
        x0 = Math.min(x0, p[0] - r); y0 = Math.min(y0, p[1] - r); x1 = Math.max(x1, p[0] + r); y1 = Math.max(y1, p[1] + r);
      }
    }
    const cell = Math.max(2, Math.max(x1 - x0, y1 - y0) / 48);
    const nx = Math.max(1, Math.ceil((x1 - x0) / cell) + 1);
    const ny = Math.max(1, Math.ceil((y1 - y0) / cell) + 1);
    const lists = new Map<number, number[]>();
    for (const i of own) {
      const mv = input.moves[i];
      const r = (radius.get(mv.tool) ?? 3) + 0.01;
      let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
      for (const p of mv.points) { a = Math.min(a, p[0] - r); b = Math.min(b, p[1] - r); c = Math.max(c, p[0] + r); d = Math.max(d, p[1] + r); }
      const i0 = Math.max(0, Math.floor((a - x0) / cell)), i1 = Math.min(nx - 1, Math.floor((c - x0) / cell));
      const j0 = Math.max(0, Math.floor((b - y0) / cell)), j1 = Math.min(ny - 1, Math.floor((d - y0) / cell));
      for (let j = j0; j <= j1; j++) for (let k = i0; k <= i1; k++) {
        const key = j * nx + k;
        const l = lists.get(key);
        if (l) l.push(i);
        else lists.set(key, [i]);
      }
    }
    return { lo: [x0, y0] as [number, number], cell, nx, ny, lists };
  });
  const ix = { bins, reach };
  indexes.set(input, ix);
  return ix;
}

/**
 * Where the material really ends past a solid sample: from its centre p, along `axis` towards
 * `sign`, the distance (0..len) to the face left by the deepest of the moves before `before` that
 * cut there (`first`: the move that cut the next sample first).
 */
function faceFinder(input: SimInput, before: number) {
  const toolOf = new Map(input.tools.map((t) => [t.tool, t]));
  const index = moveIndex(input);
  const cutBy = (m: number, p: Vec) => {
    const mv = input.moves[m];
    const s = mv && input.setups[mv.setup];
    if (!s) return false;
    const R = s.orient;
    const t = s.offset;
    const mx = R[0] * p[0] + R[1] * p[1] + R[2] * p[2] + t[0];
    const my = R[3] * p[0] + R[4] * p[1] + R[5] * p[2] + t[1];
    const mz = R[6] * p[0] + R[7] * p[1] + R[8] * p[2] + t[2];
    const tool = toolOf.get(mv.tool) ?? { tool: mv.tool, radius: 3, slope: null };
    for (let q = 1; q < mv.points.length; q++) if (sweeps(mx, my, mz, mv.points[q - 1], mv.points[q], tool.radius, tool.slope)) return true;
    return false;
  };
  /**
   * Every move before `before` that cuts part point p, the one that cut it first (`first`) leading.
   * Several moves cut the same place (face-mill layers, roughing then finishing): the deepest decides
   * where the material ends. A tool clears everything above it, so the moves that cut a point next to
   * the material are also the ones that cut between it and the material (sideways, only a hole thinner
   * than one sample step could slip between; the grid cannot see that anyway).
   */
  const cutters = (p: Vec, first: number) => {
    const found = [first];
    const box = index.reach;
    for (let s = 0; s < input.setups.length; s++) {
      const R = input.setups[s].orient;
      const t = input.setups[s].offset;
      const b = index.bins[s];
      const mx = R[0] * p[0] + R[1] * p[1] + R[2] * p[2] + t[0];
      const my = R[3] * p[0] + R[4] * p[1] + R[5] * p[2] + t[1];
      const mz = R[6] * p[0] + R[7] * p[1] + R[8] * p[2] + t[2];
      const k = Math.floor((mx - b.lo[0]) / b.cell);
      const j = Math.floor((my - b.lo[1]) / b.cell);
      if (k < 0 || j < 0 || k >= b.nx || j >= b.ny) continue;
      for (const m of b.lists.get(j * b.nx + k) ?? []) {
        if (m >= before) break;
        // Cheap first: outside the move's reach, or below its lowest point, it cannot cut there.
        const o = m * 5;
        if (m === first || mx < box[o] || mx > box[o + 1] || my < box[o + 2] || my > box[o + 3] || mz < box[o + 4]) continue;
        if (cutBy(m, p)) found.push(m);
      }
    }
    return found;
  };
  return (p: Vec, first: number, axis: 0 | 1 | 2, sign: 1 | -1, len: number) => {
    const q: Vec = [p[0], p[1], p[2]];
    q[axis] = p[axis] + sign * len;
    const by = cutters(q, first);
    let lo = 0;
    let hi = len;
    for (let it = 0; it < 10; it++) {
      const mid = (lo + hi) / 2;
      q[axis] = p[axis] + sign * mid;
      if (by.some((mm) => cutBy(mm, q))) hi = mid;
      else lo = mid;
    }
    return lo;
  };
}

export function materialExtreme(input: SimInput, g: Grid, before: number, axis: 0 | 1 | 2, sign: 1 | -1, keep?: (p: Vec) => boolean): number | null {
  const { n, step, origin, removed } = g;
  const reachOf = faceFinder(input, before);
  const [u, w] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
  const id = (c: number[]) => (c[2] * n[1] + c[1]) * n[0] + c[0];
  const c = [0, 0, 0];
  for (let L = sign > 0 ? n[axis] - 1 : 0; L >= 0 && L < n[axis]; L -= sign) {
    let best: number | null = null;
    for (let a = 0; a < n[u]; a++)
      for (let b = 0; b < n[w]; b++) {
        c[axis] = L;
        c[u] = a;
        c[w] = b;
        if (removed[id(c)] < before) continue;
        const p: Vec = [origin[0] + (c[0] + 0.5) * step[0], origin[1] + (c[1] + 0.5) * step[1], origin[2] + (c[2] + 0.5) * step[2]];
        if (keep && !keep(p)) continue;
        // Beyond this voxel: the raw face, or material cut by the moves before (the deepest of them).
        const out = L + sign;
        let reach = 0;
        if (out >= 0 && out < n[axis]) {
          c[axis] = out;
          const m = removed[id(c)];
          reach = step[axis];
          if (m < before) reach = reachOf(p, m, axis, sign, step[axis]);
        }
        // Untouched raw face: exactly the block's face (no voxel arithmetic).
        const v = out < 0 || out >= n[axis] ? (sign > 0 ? input.part.max[axis] : input.part.min[axis]) : p[axis] + sign * reach;
        if (best === null || v * sign > best * sign) best = v;
      }
    if (best !== null) return best;
  }
  return null;
}

/**
 * Wall thickness of the finished part at every sample (mm; Infinity where cut away): the shortest
 * run of solid material through it along X, Y or Z. Thin walls, skins, bridges between holes and
 * thin ribs come out small: the places that can break or chip. Runs shorter than `exactBelow` mm
 * end on the exact faces the tools left (not on the samples), so thin walls read to a tenth of a
 * millimetre; a wall thinner than one sample step can still be missed where no sample lies in it.
 * shortcut: along the axes only, so a thin wall at 45° reads up to 1.4× thicker; a true local
 * thickness (largest ball inside) is the upgrade if that misleads.
 */
export function wallThickness(g: Grid, input?: SimInput, exactBelow = 4): Float32Array {
  const [nx, ny, nz] = g.n;
  const th = new Float32Array(nx * ny * nz).fill(Infinity);
  const stride = [1, nx, nx * ny];
  const reachOf = input ? faceFinder(input, KEPT) : null;
  const centre = (v: number): Vec => [g.origin[0] + ((v % nx) + 0.5) * g.step[0], g.origin[1] + ((Math.floor(v / nx) % ny) + 0.5) * g.step[1], g.origin[2] + (Math.floor(v / (nx * ny)) + 0.5) * g.step[2]];
  for (let a = 0 as 0 | 1 | 2; a < 3; a++) {
    const [b, c] = a === 0 ? [1, 2] : a === 1 ? [0, 2] : [0, 1];
    const h = g.step[a];
    for (let j = 0; j < g.n[b]; j++)
      for (let k = 0; k < g.n[c]; k++) {
        const base = j * stride[b] + k * stride[c];
        for (let i = 0; i < g.n[a]; ) {
          if (g.removed[base + i * stride[a]] !== KEPT) {
            i++;
            continue;
          }
          let e = i;
          while (e < g.n[a] && g.removed[base + e * stride[a]] === KEPT) e++;
          let len = (e - i) * h;
          if (reachOf && len < exactBelow) {
            // From the end samples' centres to the faces: half a step at a raw face (the grid fills the block).
            const first = base + i * stride[a];
            const last = base + (e - 1) * stride[a];
            const lo = i > 0 ? reachOf(centre(first), g.removed[first - stride[a]], a, -1, h) : h / 2;
            const hi = e < g.n[a] ? reachOf(centre(last), g.removed[last + stride[a]], a, 1, h) : h / 2;
            len = (e - i - 1) * h + lo + hi;
          }
          for (let q = i; q < e; q++) {
            const v = base + q * stride[a];
            if (len < th[v]) th[v] = len;
          }
          i = e;
        }
      }
  }
  return th;
}

/** Thinnest wall at each surface point (positions x, y, z, …): the least of the samples around it. */
export function thicknessAt(g: Grid, th: Float32Array, positions: Float32Array): Float32Array {
  const [nx, ny, nz] = g.n;
  const out = new Float32Array(positions.length / 3);
  for (let p = 0; p < out.length; p++) {
    const f = [0, 1, 2].map((a) => Math.floor((positions[p * 3 + a] - g.origin[a]) / g.step[a] - 0.5));
    let best = Infinity;
    for (let dz = 0; dz < 2; dz++)
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const x = f[0] + dx, y = f[1] + dy, z = f[2] + dz;
          if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
          best = Math.min(best, th[(z * ny + y) * nx + x]);
        }
    out[p] = best;
  }
  return out;
}

/** A round hole a pure plunge left in the part (part frame, mm): rim centre, bottom centre (where its full Ø ends). */
export interface Hole {
  top: Vec;
  bottom: Vec;
  r: number;
  tool: number | null;
  /** Last move that plunged there. */
  move: number;
  /** The face round the rim is flat (the same height all round). */
  flat: boolean;
  /** Wall all the way round at every depth (not opened into a pocket or an edge). */
  closed: boolean;
}

/** The circle a move's path follows in XY (an arc or a helix), with how far round it goes (radians); null if not one. */
export function circleOfPath(pts: Vec[]): { x: number; y: number; r: number; sweep: number } | null {
  if (pts.length < 4) return null;
  // Three points well apart in XY (on a helix of whole turns, points at fixed shares of the path fall on top of each other).
  const far = (from: Vec[]) => pts.reduce((best, p) => (Math.min(...from.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1]))) > Math.min(...from.map((q) => Math.hypot(best[0] - q[0], best[1] - q[1]))) ? p : best), pts[0]);
  const a = pts[0];
  const b = far([a]);
  const c = far([a, b]);
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-9) return null;
  const q = (p: Vec) => p[0] * p[0] + p[1] * p[1];
  const x = (q(a) * (b[1] - c[1]) + q(b) * (c[1] - a[1]) + q(c) * (a[1] - b[1])) / d;
  const y = (q(a) * (c[0] - b[0]) + q(b) * (a[0] - c[0]) + q(c) * (b[0] - a[0])) / d;
  const r = Math.hypot(a[0] - x, a[1] - y);
  if (r < 0.05 || pts.some((p) => Math.abs(Math.hypot(p[0] - x, p[1] - y) - r) > 0.01)) return null;
  let sweep = 0;
  for (let i = 1; i < pts.length; i++) {
    let da = Math.atan2(pts[i][1] - y, pts[i][0] - x) - Math.atan2(pts[i - 1][1] - y, pts[i - 1][0] - x);
    if (da > Math.PI) da -= 2 * Math.PI;
    if (da < -Math.PI) da += 2 * Math.PI;
    sweep += Math.abs(da);
  }
  return { x, y, r, sweep };
}

/**
 * The round holes in the part after the moves before `before`, known from the moves, not read off
 * the samples:
 * - every pure vertical plunge (Z only, no X or Y) makes one of exactly the tool's Ø (pecks and
 *   repeats at one spot are one hole);
 * - a flat tool going all the way round one centre (full circles or a helix, in one move or several)
 *   makes a bore of the circle's Ø plus the tool's, when it cleared the middle (not a boss or a groove).
 * The samples only say where it has walls: from the highest to the lowest level with material nearly
 * all round it (a hole later opened up by a bigger tool, or milled away, has none there and is dropped).
 */
export function drilledHoles(input: SimInput, g: Grid, before: number): Hole[] {
  const toolOf = new Map(input.tools.map((t) => [t.tool, t]));
  type Cand = { setup: number; tool: number | null; x: number; y: number; lo: number; hi: number; move: number; path: number; sweep: number };
  const plunges = new Map<string, Cand>();
  const rounds = new Map<string, Cand>();
  const add = (into: Map<string, Cand>, key: string, c: Cand) => {
    const h = into.get(key);
    if (h) Object.assign(h, { lo: Math.min(h.lo, c.lo), hi: Math.max(h.hi, c.hi), move: c.move, sweep: h.sweep + c.sweep });
    else into.set(key, c);
  };
  input.moves.forEach((mv, i) => {
    if (i >= before || mv.points.length < 2) return;
    let lo = Infinity, hi = -Infinity;
    for (const p of mv.points) {
      lo = Math.min(lo, p[2]);
      hi = Math.max(hi, p[2]);
    }
    const [x, y] = mv.points[0];
    if (mv.points.every((p) => Math.abs(p[0] - x) <= 1e-4 && Math.abs(p[1] - y) <= 1e-4)) {
      if (hi - lo >= 0.05) add(plunges, `${mv.setup}|${x.toFixed(3)}|${y.toFixed(3)}|${mv.tool}`, { setup: mv.setup, tool: mv.tool, x, y, lo, hi, move: i, path: 0, sweep: 0 });
      return;
    }
    const c = circleOfPath(mv.points);
    if (c) add(rounds, `${mv.setup}|${c.x.toFixed(2)}|${c.y.toFixed(2)}|${c.r.toFixed(2)}|${mv.tool}`, { setup: mv.setup, tool: mv.tool, x: c.x, y: c.y, lo, hi, move: i, path: c.r, sweep: c.sweep });
  });
  const solid = (p: Vec) => {
    const c = [0, 1, 2].map((a) => Math.round((p[a] - g.origin[a]) / g.step[a] - 0.5));
    if (c.some((v, a) => v < 0 || v >= g.n[a])) return false;
    return g.removed[(c[2] * g.n[1] + c[1]) * g.n[0] + c[0]] >= before;
  };
  const holes: Hole[] = [];
  let reachOf: ReturnType<typeof faceFinder> | undefined;
  const bores = [...rounds.values()].filter((h) => h.sweep >= Math.PI * 2 * 0.97 && toolOf.get(h.tool)?.slope === null);
  for (const h of [...plunges.values(), ...bores]) {
    const s = input.setups[h.setup];
    const tool = toolOf.get(h.tool);
    if (!s || !tool) continue;
    const R = s.orient;
    const t = s.offset;
    const toPart = (m: Vec): Vec => [0, 1, 2].map((k) => R[k] * (m[0] - t[0]) + R[3 + k] * (m[1] - t[1]) + R[6 + k] * (m[2] - t[2])) as Vec;
    const bore = h.path > 0;
    const radius = h.path + tool.radius;
    // A bore: the middle cleared (a circle round material is a boss or a groove, not a hole).
    if (bore && solid(toPart([h.x, h.y, h.lo + g.size]))) continue;
    // Around the hole, just past its wall (one sample beyond, so the nearest sample is outside it).
    const ring = radius + g.size;
    const wallAt = (z: number) => {
      let n = 0;
      for (let k = 0; k < 8; k++) if (solid(toPart([h.x + ring * Math.cos((k * Math.PI) / 4), h.y + ring * Math.sin((k * Math.PI) / 4), z]))) n++;
      return n;
    };
    // A plunge needs wall nearly all round (one beside a pocket wall is not a hole); a bore is known
    // round from its moves, so half its wall is enough (one breaking into a pocket still counts).
    let closed = true;
    const walled = (z: number) => {
      const n = wallAt(z);
      if (n < (bore ? 4 : 6)) return false;
      if (n < 8) closed = false;
      return true;
    };
    // Full Ø only above a pointed tool's cone.
    const floor = h.lo + (typeof tool.slope === 'number' ? tool.radius / tool.slope : 0);
    // A plunge starts above the part; a bore's wall goes up to the top of the part (the tool clears all above it).
    let start = h.hi;
    if (bore) for (let c = 0; c < 8; c++) start = Math.max(start, R[6] * (c & 1 ? input.part.max : input.part.min)[0] + R[7] * (c & 2 ? input.part.max : input.part.min)[1] + R[8] * (c & 4 ? input.part.max : input.part.min)[2] + t[2]);
    let top: number | null = null;
    let bottom = floor;
    for (let z = start; z >= floor; z -= g.size / 2)
      if (walled(z)) {
        top ??= z;
        bottom = z;
      }
    // A spot drill's dimple or a plunge at a pocket's start leaves no real hole.
    if (top === null || top - bottom < 0.5) continue;
    // Down to the full-Ø end when the walls reach it (the last level checked is within half a step).
    if (bottom - floor < g.size / 2) bottom = floor;
    const rim = toPart([h.x, h.y, top]);
    // The rim on the real face around the hole (not a sample level): out of the hole along its axis
    // from the samples round it, to where the material ends (the median of them).
    const out = [0, 1, 2].map((k) => R[6 + k]);
    const a = out.map(Math.abs).indexOf(Math.max(...out.map(Math.abs))) as 0 | 1 | 2;
    const sign = out[a] > 0 ? 1 : -1;
    const faces: number[] = [];
    for (let k = 0; k < 8; k++) {
      const c = [0, 1, 2].map((q) => Math.round((toPart([h.x + ring * Math.cos((k * Math.PI) / 4), h.y + ring * Math.sin((k * Math.PI) / 4), top])[q] - g.origin[q]) / g.step[q] - 0.5));
      if (c.some((v, q) => v < 0 || v >= g.n[q])) continue;
      const id = (v: number[]) => (v[2] * g.n[1] + v[1]) * g.n[0] + v[0];
      if (g.removed[id(c)] < before) continue;
      while (c[a] + sign >= 0 && c[a] + sign < g.n[a] && g.removed[id(c.map((v, q) => (q === a ? v + sign : v)))] >= before) c[a] += sign;
      const centre = c.map((v, q) => g.origin[q] + (v + 0.5) * g.step[q]) as Vec;
      const next = c[a] + sign;
      if (next < 0 || next >= g.n[a]) faces.push(sign > 0 ? input.part.max[a] : input.part.min[a]);
      else faces.push(centre[a] + sign * (reachOf ??= faceFinder(input, before))(centre, g.removed[id(c.map((v, q) => (q === a ? next : v)))], a, sign, g.step[a]));
    }
    faces.sort((x, y) => x - y);
    if (faces.length) rim[a] = faces[faces.length >> 1];
    const flat = faces.length === 8 && faces[7] - faces[0] < 0.05;
    holes.push({ top: rim, bottom: toPart([h.x, h.y, bottom]), r: radius, tool: h.tool, move: h.move, flat, closed });
  }
  // Roughed then finished (or finished twice) on one axis at the same depths: the material ends at the biggest.
  const along = (h: Hole) => {
    const d = [0, 1, 2].map((k) => h.bottom[k] - h.top[k]);
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    return d.map((x) => x / l);
  };
  return holes.filter((h) => {
    const u = along(h);
    const at = (p: Vec) => p[0] * u[0] + p[1] * u[1] + p[2] * u[2];
    return !holes.some((o) => {
      if (o === h || o.r < h.r || (o.r === h.r && holes.indexOf(o) > holes.indexOf(h))) return false;
      const w = [0, 1, 2].map((k) => o.top[k] - h.top[k]);
      const t = w[0] * u[0] + w[1] * u[1] + w[2] * u[2];
      if (Math.abs(Math.abs(along(o).reduce((s, x, k) => s + x * u[k], 0)) - 1) > 0.01 || Math.hypot(w[0] - u[0] * t, w[1] - u[1] * t, w[2] - u[2] * t) > 0.05) return false;
      const [h0, h1] = [at(h.top), at(h.bottom)];
      const [o0, o1] = [at(o.top), at(o.bottom)].sort((x, y) => x - y);
      return Math.min(h1, o1) - Math.max(h0, o0) > 0.5;
    });
  });
}

/**
 * The holder above a tool: a steel cylinder from where the tool's length (as the program states it)
 * ends, upward. Face mills sit on a narrower arbor than the cutter.
 * shortcut: one standard holder per tool size; a real holder per tool in the inventory is the upgrade
 * if checks warn about holders that are in fact slimmer.
 */
export function holderOf(diameter: number): { radius: number; height: number } {
  const r = diameter / 2;
  return r >= 12 ? { radius: Math.max(r * 0.38, 14), height: 40 } : { radius: Math.max(r + 6, 10), height: 40 };
}

/** Where a tool's holder runs into the part (machine coordinates of the holder's bottom centre). */
export interface HolderHit {
  move: number;
  tool: number | null;
  setup: number;
  point: Vec;
  /** How far into the material the holder goes (mm). */
  depth: number;
}

/**
 * The holders against the part: for every move (rapids too: `paths` are all the moves' paths on the
 * machine, `reach` the length stated for the tool in the spindle at each move), the holder (holderOf)
 * against the material still there when the move runs. Moves without a stated length are not
 * checked. Moves of one tool close together are one hit (the deepest).
 */
export function holderHits(input: SimInput, g: Grid, paths: Vec[][], reach: (number | null | undefined)[], dia: (number | null | undefined)[] = []): HolderHit[] {
  const diameter = new Map(input.tools.map((t) => [t.tool, t.radius * 2]));
  const [nx, ny, nz] = g.n;
  // The part's highest point on each setup's machine (higher holders cannot touch it).
  const tops = input.setups.map((s) => {
    let top = -Infinity;
    for (let c = 0; c < 8; c++) {
      const p = [c & 1 ? input.part.max[0] : input.part.min[0], c & 2 ? input.part.max[1] : input.part.min[1], c & 4 ? input.part.max[2] : input.part.min[2]];
      top = Math.max(top, s.orient[6] * p[0] + s.orient[7] * p[1] + s.orient[8] * p[2] + s.offset[2]);
    }
    return top;
  });
  const hits: HolderHit[] = [];
  let open: HolderHit | null = null;
  let openLast = -Infinity;
  paths.forEach((path, i) => {
    const mv = input.moves[i];
    const L = reach[i];
    const s = mv && input.setups[mv.setup];
    if (!s || !L || path.length < 1) return;
    const R = s.orient;
    const t = s.offset;
    const top = tops[mv.setup];
    const { radius, height } = holderOf(dia[i] ?? diameter.get(mv.tool) ?? 6);
    // Material when this move runs: not cut by this move or any before it.
    const solid = (mx: number, my: number, mz: number) => {
      const d0 = mx - t[0], d1 = my - t[1], d2 = mz - t[2];
      const i0 = Math.round((R[0] * d0 + R[3] * d1 + R[6] * d2 - g.origin[0]) / g.step[0] - 0.5);
      const i1 = Math.round((R[1] * d0 + R[4] * d1 + R[7] * d2 - g.origin[1]) / g.step[1] - 0.5);
      const i2 = Math.round((R[2] * d0 + R[5] * d1 + R[8] * d2 - g.origin[2]) / g.step[2] - 0.5);
      if (i0 < 0 || i1 < 0 || i2 < 0 || i0 >= nx || i1 >= ny || i2 >= nz) return false;
      return g.removed[(i2 * ny + i1) * nx + i0] > i;
    };
    let worst: HolderHit | null = null;
    const st = g.size;
    // Inside the holder by at least half a sample, so a holder just grazing a wall is not a hit.
    const inner = radius - st * 0.5;
    const check = (p: Vec) => {
      const zb = p[2] + L;
      if (zb >= top - st * 0.5) return;
      const zTop = Math.min(zb + height, top);
      for (let dx = -inner; dx <= inner; dx += st)
        for (let dy = -inner; dy <= inner; dy += st) {
          if (dx * dx + dy * dy > inner * inner) continue;
          // From the top down: the highest material in this column under the holder's top.
          for (let z = zTop - st * 0.5; z > zb + st * 0.5; z -= st)
            if (solid(p[0] + dx, p[1] + dy, z)) {
              if (!worst || z - zb > worst.depth) worst = { move: i, tool: mv.tool, setup: mv.setup, point: [p[0], p[1], zb], depth: z - zb };
              break;
            }
        }
    };
    // Along the move, about every half holder radius.
    check(path[0]);
    for (let k = 1; k < path.length; k++) {
      const a = path[k - 1];
      const b = path[k];
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / (radius / 2)));
      for (let q = 1; q <= n; q++) check([a[0] + ((b[0] - a[0]) * q) / n, a[1] + ((b[1] - a[1]) * q) / n, a[2] + ((b[2] - a[2]) * q) / n]);
    }
    const hit = worst as HolderHit | null;
    if (!hit) return;
    if (open && open.tool === hit.tool && hit.move - openLast <= 3) {
      if (hit.depth > open.depth) Object.assign(open, { depth: hit.depth, point: hit.point });
    } else {
      open = hit;
      hits.push(hit);
    }
    openLast = hit.move;
  });
  return hits;
}

export const CHUNK = 24;

export interface ChunkMesh {
  id: number;
  positions: Float32Array;
  normals: Float32Array;
  /** 1 = a cut surface, 0 = an outside surface of the raw part. */
  cut: Uint8Array;
  /** Wall thickness of the finished part at each point (mm, see wallThickness). */
  thick?: Float32Array;
}

export interface Mesher {
  chunks: number;
  /** Chunks whose surface differs between two instants of the program (see SUB). */
  dirty(from: number, to: number): number[];
  /** The surface of a chunk at an instant (see SUB). */
  build(id: number, at: number): ChunkMesh;
}

interface Cross {
  p: Vec;
  n: Vec;
  cut: boolean;
  /** +1: solid on the low side of the edge (surface faces +axis), -1: the other way. */
  dir: number;
  /** The point and normal are the true surface's (false: a stand-in, square to the edge). */
  exact: boolean;
  /** On a sliver too narrow to draw (see crossing): it places the surface but does not shade it. */
  minor?: boolean;
}

export function mesher(g: Grid, input: SimInput): Mesher {
  const [nx, ny, nz] = g.n;
  const { origin, step: h } = g;
  const cx = Math.ceil((nx + 1) / CHUNK);
  const cy = Math.ceil((ny + 1) / CHUNK);
  const cz = Math.ceil((nz + 1) / CHUNK);
  const count = cx * cy * cz;
  const toolOf = new Map(input.tools.map((t) => [t.tool, t]));

  // The instant each sample is cut (KEPT: never).
  const instantOf = (v: number) => {
    const r = g.removed[v];
    return r === KEPT ? KEPT : r * SUB + (g.share[v] >> 6);
  };
  // Where each cutting move can cut, as a box in the part frame (for the moves just before the
  // current instant, which shape the fresh surface).
  const boxes = new Float64Array(input.moves.length * 6).fill(NaN);
  input.moves.forEach((mv, m) => {
    const s = input.setups[mv.setup];
    if (mv.points.length < 2 || !s) return;
    const r = (toolOf.get(mv.tool) ?? { radius: 3 }).radius;
    const lo: Vec = [Infinity, Infinity, Infinity];
    const hi: Vec = [-Infinity, -Infinity, 1e6];
    for (const p of mv.points) {
      lo[0] = Math.min(lo[0], p[0] - r);
      lo[1] = Math.min(lo[1], p[1] - r);
      lo[2] = Math.min(lo[2], p[2]);
      hi[0] = Math.max(hi[0], p[0] + r);
      hi[1] = Math.max(hi[1], p[1] + r);
    }
    const R = s.orient;
    for (let a = 0; a < 3; a++) {
      // Part axis a is machine axis b (quarter turns), possibly reversed.
      const b = [R[a], R[3 + a], R[6 + a]].findIndex((x) => x !== 0);
      const sign = [R[a], R[3 + a], R[6 + a]][b];
      const x0 = sign * (lo[b] - s.offset[b]);
      const x1 = sign * (hi[b] - s.offset[b]);
      boxes[m * 6 + a] = Math.min(x0, x1);
      boxes[m * 6 + 3 + a] = Math.max(x0, x1);
    }
  });
  const near = (m: number, p: Vec) =>
    p[0] >= boxes[m * 6] && p[0] <= boxes[m * 6 + 3] && p[1] >= boxes[m * 6 + 1] && p[1] <= boxes[m * 6 + 4] && p[2] >= boxes[m * 6 + 2] && p[2] <= boxes[m * 6 + 5];
  /** Moves before the current one that still count as fresh. */
  const RECENT = 24;
  const index = moveIndex(input);
  /** Every move up to `now` that can reach part point p (from the moves binned by place). */
  const reaching = (p: Vec, now: number) => {
    const out: number[] = [];
    for (let s = 0; s < input.setups.length; s++) {
      const R = input.setups[s].orient;
      const t = input.setups[s].offset;
      const b = index.bins[s];
      const mx = R[0] * p[0] + R[1] * p[1] + R[2] * p[2] + t[0];
      const my = R[3] * p[0] + R[4] * p[1] + R[5] * p[2] + t[1];
      const mz = R[6] * p[0] + R[7] * p[1] + R[8] * p[2] + t[2];
      const k = Math.floor((mx - b.lo[0]) / b.cell);
      const j = Math.floor((my - b.lo[1]) / b.cell);
      if (k < 0 || j < 0 || k >= b.nx || j >= b.ny) continue;
      for (const m of b.lists.get(j * b.nx + k) ?? []) {
        if (m > now) break;
        const o = m * 5;
        if (mx >= index.reach[o] && mx <= index.reach[o + 1] && my >= index.reach[o + 2] && my <= index.reach[o + 3] && mz >= index.reach[o + 4]) out.push(m);
      }
    }
    return out;
  };

  // Running shares of every cutting move, for cutting a move short at the current instant.
  const runs = new Map<number, Float64Array>();
  const runOf = (m: number) => {
    let r = runs.get(m);
    if (!r) runs.set(m, (r = runShares(input.moves[m].points)));
    return r;
  };

  // Cells are numbered from -1 (outside the part) so chunk a holds cells a*CHUNK-1 ...
  const chunkOf = (c: number) => Math.floor((c + 1) / CHUNK);
  // The instants that change each chunk (with a two-sample border), sorted, for exact updates.
  const lists: number[][] = Array.from({ length: count }, () => []);
  const mark = (v: number, r: number) => {
    const i = v % nx;
    const j = Math.floor(v / nx) % ny;
    const k = Math.floor(v / (nx * ny));
    const a0 = Math.max(0, chunkOf(i - 2));
    const a1 = Math.min(cx - 1, chunkOf(i + 1));
    const b0 = Math.max(0, chunkOf(j - 2));
    const b1 = Math.min(cy - 1, chunkOf(j + 1));
    const c0 = Math.max(0, chunkOf(k - 2));
    const c1 = Math.min(cz - 1, chunkOf(k + 1));
    for (let c = c0; c <= c1; c++) for (let b = b0; b <= b1; b++) for (let a = a0; a <= a1; a++) lists[(c * cy + b) * cx + a].push(r);
  };
  for (let v = 0; v < g.removed.length; v++) {
    const r = instantOf(v);
    if (r !== KEPT) mark(v, r);
  }
  // A later pass that only skims the surface changes it too: while it runs and once it is done.
  for (const [v, m] of g.outer ?? []) {
    mark(v, m * SUB);
    mark(v, (m + 1) * SUB - 1);
  }
  const changes = lists.map((l) => Int32Array.from(new Set(l)).sort());
  /** Does chunk id change at any instant in [a, b)? */
  const changesBetween = (id: number, a: number, b: number) => {
    const l = changes[id];
    let x = 0;
    let y = l.length;
    while (x < y) {
      const mid = (x + y) >> 1;
      if (l[mid] < a) x = mid + 1;
      else y = mid;
    }
    return x < l.length && l[x] < b;
  };

  const sampleAt = (i: number, j: number, k: number): Vec => [origin[0] + (i + 0.5) * h[0], origin[1] + (j + 0.5) * h[1], origin[2] + (k + 0.5) * h[2]];
  const inGrid = (i: number, j: number, k: number) => i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz;
  const toMachine = (s: { orient: Mat3; offset: Vec }, p: Vec): Vec => {
    const R = s.orient;
    return [R[0] * p[0] + R[1] * p[1] + R[2] * p[2] + s.offset[0], R[3] * p[0] + R[4] * p[1] + R[5] * p[2] + s.offset[1], R[6] * p[0] + R[7] * p[1] + R[8] * p[2] + s.offset[2]];
  };
  const toPart = (s: { orient: Mat3 }, v: Vec): Vec => {
    const R = s.orient;
    return [R[0] * v[0] + R[3] * v[1] + R[6] * v[2], R[1] * v[0] + R[4] * v[1] + R[7] * v[2], R[2] * v[0] + R[5] * v[1] + R[8] * v[2]];
  };
  /**
   * Is part point p inside what move m sweeps up to share `upTo` of it (1 = the whole move)?
   * Returns the first segment from `from` on that covers it and where that segment ends (cut short
   * for the move in progress), or null.
   */
  const inMove = (m: number, p: Vec, upTo: number, from = 1): { seg: number; end: Vec } | null => {
    const mv = input.moves[m];
    const s = input.setups[mv.setup];
    const tool = toolOf.get(mv.tool) ?? { radius: 3, slope: null };
    const q = toMachine(s, p);
    const run = upTo < 1 ? runOf(m) : null;
    for (let i = from; i < mv.points.length; i++) {
      const a = mv.points[i - 1];
      let b = mv.points[i];
      if (run) {
        if (run[i - 1] >= upTo) break;
        if (run[i] > upTo) {
          const t = (upTo - run[i - 1]) / (run[i] - run[i - 1]);
          b = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        }
      }
      if (sweeps(q[0], q[1], q[2], a, b, tool.radius, tool.slope)) return { seg: i, end: b };
    }
    return null;
  };

  /**
   * Which way the surface that segment c of move c.m leaves at part point p faces (part frame), and
   * the setup and tool that left it. Which part of the tool (floor, wall, cone) is told apart to 0.01 mm.
   */
  const surfaceAt = (c: { m: number; seg: number; end: Vec }, p: Vec) => {
    const mv = input.moves[c.m];
    const s = input.setups[mv.setup];
    const tool = toolOf.get(mv.tool) ?? { radius: 3, slope: null };
    const nm = sweepNormal(toMachine(s, p), mv.points[c.seg - 1], c.end, tool.radius, tool.slope, 0.01);
    return { s, tool, nm, n: toPart(s, nm) };
  };
  /** Is part point q cut by instant (now, upToNow): by these moves, or any other move reaching it? */
  const cutBy = (q: Vec, moves: number[], now: number, upToNow: number) =>
    moves.some((m) => !!inMove(m, q, m === now ? upToNow : 1)) || reaching(q, now).some((m) => !!inMove(m, q, m === now ? upToNow : 1));

  /**
   * Where the surface crosses the edge from sample A (solid) to sample B (cut or outside), and
   * which way it faces. dir: +1 if B is the next sample along the axis, -1 if the previous.
   * The cut surface is the edge of everything cut near B so far (roughing and finishing passes
   * together), found by halving the edge, so walls come out straight and smooth.
   */
  const crossing = (A: [number, number, number], axis: number, dir: number, B: [number, number, number], at: number): Cross => {
    const pa = sampleAt(A[0], A[1], A[2]);
    const half = (cut: boolean): Cross => {
      const p: Vec = [...pa];
      p[axis] += (dir * h[axis]) / 2;
      const n: Vec = [0, 0, 0];
      n[axis] = dir;
      // A face of the raw block lies exactly there; a cut surface only roughly.
      return { p, n, cut, dir, exact: !cut };
    };
    if (!inGrid(B[0], B[1], B[2])) return half(false);
    // Moves that cut B or the samples next to it before this instant; the move in progress
    // only as far as the tool has gone.
    const moves: number[] = [];
    const now = Math.floor(at / SUB);
    const upToNow = (at - now * SUB) / SUB;
    const add = (i: number, j: number, k: number) => {
      if (!inGrid(i, j, k)) return;
      const v = (k * ny + j) * nx + i;
      const r = g.removed[v];
      if (instantOf(v) < at && !moves.includes(r)) moves.push(r);
      // The pass reaching furthest past it, once it has started.
      const l = g.outer?.get(v);
      if (l !== undefined && l <= now && !moves.includes(l)) moves.push(l);
    };
    add(B[0], B[1], B[2]);
    for (let a = 0; a < 3; a++)
      for (const d of [-1, 1]) {
        const c: [number, number, number] = [B[0], B[1], B[2]];
        c[a] += d;
        add(c[0], c[1], c[2]);
      }
    // The move in progress and the ones just before it, where they reach.
    const pB = sampleAt(B[0], B[1], B[2]);
    for (let m = Math.min(now, input.moves.length - 1); m >= Math.max(0, now - RECENT); m--) if (!moves.includes(m) && near(m, pB)) moves.push(m);
    const covering = (p: Vec): { m: number; seg: number; end: Vec } | null => {
      for (const m of moves) {
        const c = inMove(m, p, m === now ? upToNow : 1);
        if (c) return { m, ...c };
      }
      return null;
    };
    const pb: Vec = [...pa];
    pb[axis] += dir * h[axis];
    let hit = covering(pb);
    // Where two cuts meet (a hole drilled from one side into a pocket from the other), the move
    // that shapes the edge may not have cut any sample here first: look up every move reaching it.
    if (!hit) {
      for (const m of reaching(pb, now)) if (!moves.includes(m)) moves.push(m);
      hit = covering(pb);
    }
    if (!hit || covering(pa)) return half(true);
    const along = (t: number): Vec => [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t];
    let t0 = 0;
    let t1 = 1;
    for (let it = 0; it < 8; it++) {
      const tm = (t0 + t1) / 2;
      const c = covering(along(tm));
      if (c) {
        t1 = tm;
        hit = c;
      } else t0 = tm;
    }
    const p = along((t0 + t1) / 2);
    // The crossing lies on the tool's surface within a few µm.
    let found = surfaceAt(hit, p);
    // Several passes (and segments of one pass) can reach the crossing; it lies on the one with solid
    // material right behind it (a pass whose rim just touches a floor the next one cut is not that floor).
    // Only a normal that this edge barely crosses (mostly square to it) can be another surface's.
    if (found.n[axis] * dir < 0.5) {
      const q = along(t1);
      const solidBehind = (n: Vec) => !cutBy([q[0] - n[0] * 0.01, q[1] - n[1] * 0.01, q[2] - n[2] * 0.01], moves, now, upToNow);
      if (!solidBehind(found.n))
        search: for (const m of new Set([hit.m, ...moves, ...reaching(q, now)])) {
          const upTo = m === now ? upToNow : 1;
          for (let c = inMove(m, q, upTo); c; c = inMove(m, q, upTo, c.seg + 1)) {
            const o = surfaceAt({ m, seg: c.seg, end: c.end }, p);
            if (solidBehind(o.n)) {
              found = o;
              break search;
            }
          }
        }
    }
    const { s, tool, nm, n } = found;
    // A normal facing into the material along this edge is not this surface's: stand in for it.
    // (One nearly along the edge is right: a slope or a curve that the edge just grazes.)
    if (n[axis] * dir < -0.3) return { ...half(true), p };
    // A pointed tool's cone that leaves only a sliver (a deburr, a spot drill's rim a little wider
    // than the hole), narrower than half a sample: too fine to draw, and shaded in patches it glints
    // like teeth along the edge. It still places the surface; the faces either side shade it.
    if (typeof tool.slope === 'number' && nm[2] > 1e-6 && nm[2] < 0.999) {
      const cell = Math.max(h[0], h[1], h[2]);
      // Down the cone's slope (in the plane of its axis), both ways from the crossing.
      const k = Math.hypot(nm[0], nm[1]) || 1;
      const down = toPart(s, [(nm[0] / k) * nm[2], (nm[1] / k) * nm[2], -k]);
      const onCone = (t: number) => {
        const q: Vec = [p[0] + down[0] * t, p[1] + down[1] * t, p[2] + down[2] * t];
        const solidSide: Vec = [q[0] - n[0] * 0.01, q[1] - n[1] * 0.01, q[2] - n[2] * 0.01];
        const inPart = solidSide.every((x, a) => x >= origin[a] && x <= origin[a] + g.n[a] * h[a]);
        return inPart && !cutBy(solidSide, moves, now, upToNow) && cutBy([q[0] + n[0] * 0.01, q[1] + n[1] * 0.01, q[2] + n[2] * 0.01], moves, now, upToNow);
      };
      let width = 0;
      for (const sign of [1, -1]) for (let t = cell / 8; t <= cell / 2 && width < cell / 2 && onCone(sign * t); t += cell / 8) width += cell / 8;
      if (width < cell / 2) return { p, n, cut: true, dir, exact: true, minor: true };
    }
    return { p, n, cut: true, dir, exact: true };
  };

  return {
    chunks: count,
    dirty(from, to) {
      const a = Math.min(from, to);
      const b = Math.max(from, to);
      const out: number[] = [];
      for (let id = 0; id < count; id++) if (changesBetween(id, a, b)) out.push(id);
      return out;
    },
    build(id, at) {
      const ca = id % cx;
      const cb = Math.floor(id / cx) % cy;
      const cc = Math.floor(id / (cx * cy));
      const solid = (i: number, j: number, k: number) => inGrid(i, j, k) && instantOf((k * ny + j) * nx + i) >= at;

      // Crossings on edges, cached: key = sample index * 3 + axis (edge to the next sample).
      const edgeCache = new Map<number, Cross | null>();
      const edgeKey = (i: number, j: number, k: number, axis: number) => (((k + 1) * (ny + 2) + (j + 1)) * (nx + 2) + (i + 1)) * 3 + axis;
      const edge = (i: number, j: number, k: number, axis: number): Cross | null => {
        const key = edgeKey(i, j, k, axis);
        if (edgeCache.has(key)) return edgeCache.get(key)!;
        const i2 = i + (axis === 0 ? 1 : 0);
        const j2 = j + (axis === 1 ? 1 : 0);
        const k2 = k + (axis === 2 ? 1 : 0);
        const s1 = solid(i, j, k);
        const s2 = solid(i2, j2, k2);
        let c: Cross | null = null;
        if (s1 && !s2) c = crossing([i, j, k], axis, 1, [i2, j2, k2], at);
        else if (!s1 && s2) c = crossing([i2, j2, k2], axis, -1, [i, j, k], at);
        edgeCache.set(key, c);
        return c;
      };

      // One vertex per cell that the surface passes through: the point that best fits the
      // planes of its crossings (sharp edges and corners), kept inside the cell.
      const vertCache = new Map<number, Vec>();
      const surfacesAt = new Map<number, Vec[]>();
      // Each surface's plane through the cell (a point on it): which one a point sits on.
      const planesAt = new Map<number, { n: Vec; p: Vec }[]>();
      const vertex = (i: number, j: number, k: number): Vec => {
        const key = ((k + 1) * (ny + 2) + (j + 1)) * (nx + 2) + (i + 1);
        const hit = vertCache.get(key);
        if (hit) return hit;
        const cs: Cross[] = [];
        for (let a = 0; a < 2; a++)
          for (let b = 0; b < 2; b++) {
            const e0 = edge(i, j + a, k + b, 0);
            const e1 = edge(i + a, j, k + b, 1);
            const e2 = edge(i + a, j + b, k, 2);
            if (e0) cs.push(e0);
            if (e1) cs.push(e1);
            if (e2) cs.push(e2);
          }
        const lo3 = sampleAt(i, j, k);
        const hi3 = sampleAt(i + 1, j + 1, k + 1);
        // Stand-in crossings only where nothing better is known: their square normals would bend a slope.
        const exact = cs.filter((c) => c.exact);
        const use = exact.length ? exact : cs;
        const faces = surfacesOf(use);
        const v = solveQef(faces, lo3, hi3);
        vertCache.set(key, v);
        const shaded = use.filter((c) => !c.minor);
        // The true normal of each surface through the cell shades the triangles lying on it: one
        // surface (a flat face, a round wall) comes out smooth, two (a chamfer and the top face)
        // keep a crisp edge between them.
        if (faces.length) {
          const shown = shaded.length && shaded.length < use.length ? surfacesOf(shaded) : faces;
          surfacesAt.set(key, shown.map((f) => f.n));
          planesAt.set(
            key,
            shown.map((f) => ({ n: f.n, p: [0, 1, 2].map((a) => f.members.reduce((x, c) => x + c.p[a], 0) / f.members.length) as Vec })),
          );
        }
        return v;
      };

      // Triangles as corner keys (cells) so shading can be smoothed where the surface is smooth.
      const keyOf = (i: number, j: number, k: number) => ((k + 1) * (ny + 2) + (j + 1)) * (nx + 2) + (i + 1);
      const triKeys: number[] = [];
      const triNormal: number[] = [];
      const triCut: number[] = [];
      const facesAt = new Map<number, number[]>();
      const tri = (ka: number, kb: number, kc: number, isCut: boolean) => {
        const a = vertCache.get(ka)!;
        const b = vertCache.get(kb)!;
        const c = vertCache.get(kc)!;
        const ux = b[0] - a[0];
        const uy = b[1] - a[1];
        const uz = b[2] - a[2];
        const vx = c[0] - a[0];
        const vy = c[1] - a[1];
        const vz = c[2] - a[2];
        const fx = uy * vz - uz * vy;
        const fy = uz * vx - ux * vz;
        const fz = ux * vy - uy * vx;
        const len = Math.hypot(fx, fy, fz);
        if (len < 1e-12) return;
        const t = triCut.length;
        triKeys.push(ka, kb, kc);
        triNormal.push(fx / len, fy / len, fz / len);
        triCut.push(isCut ? 1 : 0);
        for (const kk of [ka, kb, kc]) {
          const l = facesAt.get(kk);
          if (l) l.push(t);
          else facesAt.set(kk, [t]);
        }
      };

      /**
       * How well triangle a, b, c lies on one of the surfaces through its corners' cells (the best
       * cosine); -1 when it has no area or is folded over (faces well against n, the crossing's normal).
       */
      const fit = (ka: number, kb: number, kc: number, n: Vec) => {
        const a = vertCache.get(ka)!;
        const b = vertCache.get(kb)!;
        const c = vertCache.get(kc)!;
        const fx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
        const fy = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
        const fz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        const l = Math.hypot(fx, fy, fz);
        // A wall meeting a floor stands square to the floor's crossing: only well past that is folded.
        if (l < 1e-12 || (fx * n[0] + fy * n[1] + fz * n[2]) / l < -0.25) return -1;
        let best = -1;
        for (const k of [ka, kb, kc]) for (const sn of surfacesAt.get(k) ?? []) best = Math.max(best, (fx * sn[0] + fy * sn[1] + fz * sn[2]) / l);
        return best;
      };

      // Cells owned by this chunk; each emits the quads of the three edges at its low corner.
      const i0 = ca * CHUNK - 1;
      const j0 = cb * CHUNK - 1;
      const k0 = cc * CHUNK - 1;
      for (let k = k0; k < Math.min(nz, k0 + CHUNK); k++)
        for (let j = j0; j < Math.min(ny, j0 + CHUNK); j++)
          for (let i = i0; i < Math.min(nx, i0 + CHUNK); i++) {
            for (let axis = 0; axis < 3; axis++) {
              const e = edge(i, j, k, axis);
              if (!e) continue;
              // The four cells around this edge.
              const [p, q] = axis === 0 ? [1, 2] : axis === 1 ? [2, 0] : [0, 1];
              const cell = (dp: number, dq: number): number => {
                const c: [number, number, number] = [i, j, k];
                c[p] -= dp;
                c[q] -= dq;
                vertex(c[0], c[1], c[2]);
                return keyOf(c[0], c[1], c[2]);
              };
              const v00 = cell(1, 1);
              const v10 = cell(0, 1);
              const v11 = cell(0, 0);
              const v01 = cell(1, 0);
              // Wound so the face points out of the material (from the solid sample to the cut one),
              // split along the diagonal whose two triangles each lie on a true surface: along an edge
              // or an inside corner, not across it (a bevel); on a slope, not folded over.
              const [q0, q1, q2, q3] = e.dir > 0 ? [v00, v10, v11, v01] : [v00, v01, v11, v10];
              if (Math.min(fit(q0, q1, q2, e.n), fit(q0, q2, q3, e.n)) >= Math.min(fit(q0, q1, q3, e.n), fit(q1, q2, q3, e.n))) {
                tri(q0, q1, q2, e.cut);
                tri(q0, q2, q3, e.cut);
              } else {
                tri(q0, q1, q3, e.cut);
                tri(q1, q2, q3, e.cut);
              }
            }
          }

      // Shading: the true normal of the surface the triangle lies on (of the surfaces through its
      // corners' cells, the closest to the triangle's own), at each corner as that corner's cell has
      // it (a round wall stays round); failing that, the neighbouring faces that bend less than ~35°.
      const CREASE = Math.cos((35 * Math.PI) / 180);
      const nTri = triCut.length;
      const pos = new Float32Array(nTri * 9);
      const nor = new Float32Array(nTri * 9);
      const cut = new Uint8Array(nTri * 3);
      for (let t = 0; t < nTri; t++) {
        const fx = triNormal[t * 3];
        const fy = triNormal[t * 3 + 1];
        const fz = triNormal[t * 3 + 2];
        // A chamfer narrower than a cell can miss from a corner's cell: look at all three.
        let on: Vec | null = null;
        let onDot = 0.5;
        for (let c = 0; c < 3; c++)
          for (const sn of surfacesAt.get(triKeys[t * 3 + c]) ?? []) {
            const d = sn[0] * fx + sn[1] * fy + sn[2] * fz;
            if (d > onDot) {
              onDot = d;
              on = sn;
            }
          }
        for (let c = 0; c < 3; c++) {
          const kk = triKeys[t * 3 + c];
          const v = vertCache.get(kk)!;
          let sx = 0;
          let sy = 0;
          let sz = 0;
          let best: Vec | null = on;
          let bestDot = SAME_SURFACE;
          // Where surfaces meet (an edge, a chamfer, a sliver too fine to draw): each corner shades
          // as the surface it sits on, so the shading turns at the true edge, not along the
          // triangles (a row of teeth); a corner on the edge itself, as the triangle leans.
          const planes = planesAt.get(kk);
          if (planes && planes.length > 1) {
            let near = Infinity;
            for (const pl of planes) {
              const d = Math.abs(pl.n[0] * (v[0] - pl.p[0]) + pl.n[1] * (v[1] - pl.p[1]) + pl.n[2] * (v[2] - pl.p[2]));
              const lean = pl.n[0] * fx + pl.n[1] * fy + pl.n[2] * fz;
              // Clearly nearer (by more than the points' own error, a few hundredths) wins; else the lean.
              if (d < near - 0.05 || (d < near + 0.05 && (!best || lean > best[0] * fx + best[1] * fy + best[2] * fz))) {
                near = Math.min(near, d);
                best = pl.n;
              }
            }
          } else if (on)
            for (const sn of surfacesAt.get(kk) ?? []) {
              const d = sn[0] * on[0] + sn[1] * on[1] + sn[2] * on[2];
              if (d > bestDot) {
                bestDot = d;
                best = sn;
              }
            }
          if (best) {
            sx = best[0];
            sy = best[1];
            sz = best[2];
          } else for (const o of facesAt.get(kk)!) {
            const ox = triNormal[o * 3];
            const oy = triNormal[o * 3 + 1];
            const oz = triNormal[o * 3 + 2];
            if (ox * fx + oy * fy + oz * fz >= CREASE) {
              sx += ox;
              sy += oy;
              sz += oz;
            }
          }
          const l = Math.hypot(sx, sy, sz) || 1;
          const o = t * 9 + c * 3;
          pos[o] = v[0];
          pos[o + 1] = v[1];
          pos[o + 2] = v[2];
          nor[o] = sx / l;
          nor[o + 1] = sy / l;
          nor[o + 2] = sz / l;
          cut[t * 3 + c] = triCut[t];
        }
      }
      return { id, positions: pos, normals: nor, cut };
    },
  };
}

/** Least-squares point of the crossing planes, pulled a little toward their middle, kept in the cell. */
/** Eigen decomposition of a symmetric 3×3 matrix (Jacobi rotations). */
export function eigenSym(M: number[]): { values: Vec; vectors: Vec[] } {
  const a = M.slice();
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 12; sweep++) {
    const off = Math.abs(a[1]) + Math.abs(a[2]) + Math.abs(a[5]);
    if (off < 1e-12) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      const apq = a[p * 3 + q];
      if (Math.abs(apq) < 1e-15) continue;
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
  return { values: [a[0], a[4], a[8]], vectors: [0, 1, 2].map((k) => [v[k], v[3 + k], v[6 + k]] as Vec) };
}

/** Two crossing normals closer than this (cos 25°) belong to one surface: a round wall's facets, not an edge. */
const SAME_SURFACE = Math.cos((25 * Math.PI) / 180);

/**
 * The surfaces through a cell: its crossings grouped by which way they face, each with its mean
 * normal. A 45° chamfer and the top face are two; the facets of a round hole wall are one.
 */
export function surfacesOf(cs: Cross[]): { n: Vec; members: Cross[] }[] {
  const groups: { n: Vec; members: Cross[] }[] = [];
  for (const c of cs) {
    const g = groups.find((x) => x.members[0].n[0] * c.n[0] + x.members[0].n[1] * c.n[1] + x.members[0].n[2] * c.n[2] > SAME_SURFACE);
    if (g) g.members.push(c);
    else groups.push({ n: [0, 0, 0], members: [c] });
  }
  for (const g of groups) {
    for (const c of g.members) for (let a = 0; a < 3; a++) g.n[a] += c.n[a];
    const l = Math.hypot(g.n[0], g.n[1], g.n[2]) || 1;
    for (let a = 0; a < 3; a++) g.n[a] /= l;
  }
  return groups;
}

/**
 * The point that best fits the planes of a cell's crossings, kept in the cell. Every surface
 * weighs the same however many crossings it has, so whether an edge stays sharp does not change
 * from one cell to the next with how the samples fall.
 */
function solveQef(surfaces: { members: Cross[] }[], lo: Vec, hi: Vec): Vec {
  if (!surfaces.length) return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const m: Vec = [0, 0, 0];
  for (const g of surfaces) for (const c of g.members) for (let a = 0; a < 3; a++) m[a] += c.p[a] / g.members.length;
  for (let a = 0; a < 3; a++) m[a] /= surfaces.length;
  // Least squares for the crossing planes, in coordinates relative to m.
  const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const B = [0, 0, 0];
  for (const g of surfaces) {
    const wc = 1 / g.members.length;
    for (const c of g.members) {
      const d = c.n[0] * (c.p[0] - m[0]) + c.n[1] * (c.p[1] - m[1]) + c.n[2] * (c.p[2] - m[2]);
      for (let r = 0; r < 3; r++) {
        for (let s = 0; s < 3; s++) A[r * 3 + s] += wc * c.n[r] * c.n[s];
        B[r] += wc * c.n[r] * d;
      }
    }
  }
  // Truncated pseudo-inverse: a direction the surfaces barely pin down (one surface: along it)
  // stays at their middle; two surfaces 25° or more apart pin their edge, three a corner.
  const { values, vectors } = eigenSym(A);
  const top = Math.max(values[0], values[1], values[2], 1e-12);
  const order = [0, 1, 2].sort((p, q) => values[q] - values[p]).filter((k) => values[k] >= top * 0.04);
  // A fit outside its cell (surfaces meeting at odd angles where a hole, its chamfer and the top
  // face meet) would make a spike: give up the least pinned direction first (a corner becomes a
  // point on the edge, an edge a point on the face), down to the middle of the crossings. An edge
  // through the cell keeps its point on the edge: slid along it into the cell.
  const pad: Vec = [(hi[0] - lo[0]) * 0.15, (hi[1] - lo[1]) * 0.15, (hi[2] - lo[2]) * 0.15];
  for (let keep = order.length; keep >= 0; keep--) {
    const out: Vec = [m[0], m[1], m[2]];
    for (let i = 0; i < keep; i++) {
      const e = vectors[order[i]];
      const t = (e[0] * B[0] + e[1] * B[1] + e[2] * B[2]) / values[order[i]];
      for (let r = 0; r < 3; r++) out[r] += e[r] * t;
    }
    if (keep === 2) {
      // The edge's direction: the one the two kept surfaces leave free (indices 0 + 1 + 2 = 3).
      const e = vectors[3 - order[0] - order[1]];
      let s0 = -Infinity;
      let s1 = Infinity;
      for (let a = 0; a < 3; a++) {
        const a0 = lo[a] - pad[a] - out[a];
        const a1 = hi[a] + pad[a] - out[a];
        if (Math.abs(e[a]) < 1e-12) {
          if (a0 > 0 || a1 < 0) s0 = Infinity;
        } else {
          s0 = Math.max(s0, Math.min(a0 / e[a], a1 / e[a]));
          s1 = Math.min(s1, Math.max(a0 / e[a], a1 / e[a]));
        }
      }
      if (s0 <= s1) {
        const sl = Math.min(s1, Math.max(s0, 0));
        for (let r = 0; r < 3; r++) out[r] += e[r] * sl;
      }
    }
    let inside = true;
    for (let a = 0; a < 3; a++) if (out[a] < lo[a] - pad[a] - 1e-9 || out[a] > hi[a] + pad[a] + 1e-9) inside = false;
    if (inside || keep === 0) {
      for (let a = 0; a < 3; a++) out[a] = Math.min(hi[a], Math.max(lo[a], out[a]));
      return out;
    }
  }
  return [...m];
}
