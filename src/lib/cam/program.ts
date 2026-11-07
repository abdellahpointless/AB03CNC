import type { Tool } from '../../types';
import type { Vec } from '../toolpath';
import { ALL, IDENTITY, apply, mul, transpose, type Mat3 } from '../orient';
import { differences, layModel, voxelize, type Piece } from '../modelCompare';
import { buildInput, carve, KEPT, type Grid } from '../stockSim';
import { parseToolpath, speedsFor, type MachineSpeeds } from '../toolpath';
import { analyseProgram, OVERHANG, VISE } from '../setups';
import { CALE_HEIGHTS } from '../cales';
import { turnPhrase } from '../fixTurns';
import { SIDES, sideFeatures, upTurn, type Hole, type SideFeatures } from './features';
import { area, bounds, difference, inside, intersection, offset, rect, slice, turnTris, union, type P2, type Region } from './geom';
import { clearLevel, filled, swept, trim, type Ring } from './clear';
import { catalog, cutData, DEFAULT_LIMITS, knowledge, MILLS, toolComment, usable, type CamNote, type CamTool, type Cut, type Limits, type Need } from './tools';
import type { OpKind } from './learn';
import type { PartType } from './partType';

/*
 * CAM AI: a program for a part from its 3D model, for one machine and its tools.
 *   1. The raw part: the model's box plus the shop's usual allowance (learned).
 *   2. The sides it is clamped on: the two faces of its thinnest side, then any other side
 *      needed to reach what is left (holes from the side, steps).
 *   3. Each setup: face the top, centre-drill and drill the holes, mill level by level with the
 *      largest end mill and then smaller ones where it could not reach, chamfer.
 *   4. Written like the shop's programs (header, M0 clamping in German, G52, T M6, comments).
 * The program is then read back and simulated against the model before anyone may use it.
 */

export interface CamInput {
  tris: ArrayLike<number>;
  material: string;
  tools: Tool[];
  brand?: string;
  limits?: Limits;
  name?: string;
  number?: number;
  /** Raw size along the model's X, Y, Z (null: the model plus the learned allowance). */
  raw?: Vec | null;
  /** The machine's rapid and tool change time (Admin > Machines), else its brand's. */
  speeds?: MachineSpeeds;
  /** How the part lies in the first setup (the operator's pick, see layouts.ts): the side up, turned a quarter or not. */
  orient?: { side: string; spin: boolean };
  /** The part's family (from its PDF title, confirmed by the operator): where precision matters. */
  partType?: PartType;
  /** Template tool codes the operator does not have, and the ones picked in their place. */
  exclude?: string[];
  prefer?: string[];
}

export interface CamOp {
  kind: OpKind;
  name: string;
  tool: CamTool;
  cut: Cut;
  lines: string[];
}

export interface CamSetup {
  side: string;
  /** Model -> setup frame (p' = R p + t). */
  R: Mat3;
  t: Vec;
  notes: string[];
  shift: Vec;
  cale: number;
  ops: CamOp[];
}

export interface CamResult {
  code: string;
  setups: CamSetup[];
  missing: Need[];
  /** What CAM AI did not program (to do by hand or with another tool). */
  notes: CamNote[];
  size: Vec;
  raw: Vec;
}

const TABLE_Z = -57;
const STOP_X = -50;
const STOP_Y = 50;
const JAW = 45;
const SAFE = 50;

const n3 = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Number.isInteger(r) ? `${r}.` : String(r);
};
const mm = (v: number) => String(Math.round(v * 100) / 100);

/** Which side of the model (index in SIDES) a model axis direction is. */
const sideOf = (axis: number, sign: number) => SIDES.findIndex((s) => s.d[axis] === sign);

/** Where the part must be cut away, seen from each side (removal samples reachable from it). */
export function reachable(tris: ArrayLike<number>, lo: Vec, hi: Vec) {
  const size = [0, 1, 2].map((k) => hi[k] - lo[k]);
  const step = Math.max(0.25, Math.cbrt((size[0] * size[1] * size[2]) / 400_000));
  const n = size.map((s) => Math.max(1, Math.ceil(s / step))) as [number, number, number];
  const g = { n, step: size.map((s, k) => s / n[k]) as Vec, origin: lo, size: step } as unknown as Grid;
  const occ = voxelize(tris, IDENTITY, [0, 0, 0], g);
  const [nx, ny, nz] = n;
  const idx = (i: number, j: number, k: number) => k * nx * ny + j * nx + i;
  const reach = SIDES.map(() => new Uint8Array(occ.length));
  SIDES.forEach((s, si) => {
    const a = s.d.findIndex((v) => v !== 0);
    const sign = s.d[a];
    const dims = [nx, ny, nz];
    const [u, v] = [0, 1, 2].filter((x) => x !== a);
    for (let p = 0; p < dims[u]; p++)
      for (let q = 0; q < dims[v]; q++) {
        let free = true;
        for (let w = 0; w < dims[a]; w++) {
          const c = [0, 0, 0];
          c[a] = sign > 0 ? dims[a] - 1 - w : w;
          c[u] = p;
          c[v] = q;
          const i = idx(c[0], c[1], c[2]);
          if (occ[i]) free = false;
          else if (free) reach[si][i] = 1;
        }
      }
  });
  return { occ, reach, cell: g.step[0] * g.step[1] * g.step[2], grid: g };
}

/** The cells within one cell of a filled one (26 neighbours). */
function grown(occ: Uint8Array, [nx, ny, nz]: number[]): Uint8Array {
  const out = new Uint8Array(occ.length);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        if (!occ[k * nx * ny + j * nx + i]) continue;
        for (let c = Math.max(0, k - 1); c <= Math.min(nz - 1, k + 1); c++)
          for (let b = Math.max(0, j - 1); b <= Math.min(ny - 1, j + 1); b++)
            for (let a = Math.max(0, i - 1); a <= Math.min(nx - 1, i + 1); a++) out[c * nx * ny + b * nx + a] = 1;
      }
  return out;
}

/**
 * The cale under the part: the jaws grip as little as the cut needs (the outside is cut down to
 * 0.5 mm above the jaws), at least 3 mm to hold it, at most 6, never all of the part.
 */
function caleFor(height: number, want: number): { cale: number; grip: number } {
  const target = Math.max(3, Math.min(6, want, height - 1));
  let best: { cale: number; grip: number } | null = null;
  for (const c of CALE_HEIGHTS) {
    const grip = JAW - c;
    if (grip < 3 || grip > Math.max(3, height - 1)) continue;
    // The largest grip not over the target, else the smallest above it.
    const score = grip <= target + 1e-6 ? target - grip : 100 + grip - target;
    if (!best || score < (best.grip <= target + 1e-6 ? target - best.grip : 100 + best.grip - target)) best = { cale: c, grip };
  }
  return best ?? { cale: 42, grip: 3 };
}

/** One end mill per Ø (the longest), largest first. */
/** Without slivers thinner than 0.3 mm (what a round tool leaves in sharp inside corners). */
const opened = (r: Region) => offset(offset(r, -0.15), 0.15);
const circle = (c: [number, number], r: number) => Array.from({ length: 48 }, (_, i) => [c[0] + r * Math.cos((i * Math.PI) / 24), c[1] + r * Math.sin((i * Math.PI) / 24)] as P2);

/** What is left of the part, per level, in a setup's frame. */
interface Left {
  box: { lo: Vec; hi: Vec };
  /** The material between heights lo and hi (what the side of the tool sweeps down to lo). */
  at: (lo: number, hi: number) => Region;
  /** How far from the part the grid may show material that is not there (mm). */
  skin: number;
}

/** The raw part as a box, seen from a setup. */
function boxLeft(R: Mat3, t: Vec, lo: Vec, hi: Vec): Left {
  const p = [apply(R, lo), apply(R, hi)];
  const box = { lo: [0, 1, 2].map((k) => Math.min(p[0][k], p[1][k]) + t[k]) as Vec, hi: [0, 1, 2].map((k) => Math.max(p[0][k], p[1][k]) + t[k]) as Vec };
  const r = rect(box.lo[0], box.lo[1], box.hi[0], box.hi[1]);
  return { box, at: (lo, hi) => (hi > box.lo[2] - 0.001 && lo < box.hi[2] + 0.001 ? r : []), skin: 0 };
}

/**
 * What the setups so far leave of the part, simulated like the toolpath viewer does (their program
 * read back and cut on a grid), seen from the next setup (model -> its frame: p' = R p + t).
 */
/** The setups so far, read back and cut on a grid like the toolpath viewer does (setup 1's frame). */
function simulate(input: CamInput, done: CamSetup[], size: Vec, raw: Vec): Grid | null {
  const tp = parseToolpath(post(input, done, size, raw), speedsFor(input.brand));
  const an = analyseProgram(tp, { jawHeight: JAW });
  const sim = buildInput(tp, an);
  return sim ? carve({ ...sim, maxVoxels: 1_500_000, surfaceMoves: false, dropLoose: false }) : null;
}

function remaining(input: CamInput, done: CamSetup[], size: Vec, raw: Vec, R: Mat3, t: Vec): Left | null {
  const g = simulate(input, done, size, raw);
  if (!g) return null;
  // Setup 1's frame (the grid's) to this setup's: p' = M p + c.
  const R1 = done[0].R;
  const t1 = done[0].t;
  const M = mul(R, transpose(R1));
  const c = (() => {
    const q = apply(M, t1);
    return [t[0] - q[0], t[1] - q[1], t[2] - q[2]] as Vec;
  })();
  const axisOf = (row: number) => [0, 1, 2].find((k) => M[row * 3 + k] !== 0)!;
  const [ax, ay, az] = [axisOf(0), axisOf(1), axisOf(2)];
  const sign = (row: number, k: number) => M[row * 3 + k];
  const [nx, ny] = g.n;
  const at3 = (i: [number, number, number]) => i[2] * nx * ny + i[1] * nx + i[0];
  const centre = (k: number, i: number) => g.origin[k] + (i + 0.5) * g.step[k];
  // Box of what is left.
  const lo: Vec = [Infinity, Infinity, Infinity];
  const hi: Vec = [-Infinity, -Infinity, -Infinity];
  for (let k3 = 0; k3 < g.n[2]; k3++)
    for (let j = 0; j < g.n[1]; j++)
      for (let i = 0; i < g.n[0]; i++) {
        if (g.removed[at3([i, j, k3])] !== KEPT) continue;
        const p = apply(M, [centre(0, i), centre(1, j), centre(2, k3)]);
        for (let a = 0; a < 3; a++) {
          const half = g.step[[ax, ay, az][a]] / 2;
          lo[a] = Math.min(lo[a], p[a] + c[a] - half);
          hi[a] = Math.max(hi[a], p[a] + c[a] + half);
        }
      }
  if (!Number.isFinite(lo[0])) return null;
  const cache = new Map<number, Region>();
  const layerOf = (z: number) => Math.floor(((z - c[2]) / sign(2, az) - g.origin[az]) / g.step[az]);
  const layerAt = (layer: number): Region => {
    {
      if (layer < 0 || layer >= g.n[az]) return [];
      if (cache.has(layer)) return cache.get(layer)!;
      const rects: Region = [];
      const idx: [number, number, number] = [0, 0, 0];
      idx[az] = layer;
      for (let b = 0; b < g.n[ay]; b++) {
        idx[ay] = b;
        let run = -1;
        for (let a = 0; a <= g.n[ax]; a++) {
          idx[ax] = a;
          const solid = a < g.n[ax] && g.removed[at3(idx)] === KEPT;
          if (solid && run < 0) run = a;
          if (!solid && run >= 0) {
            const x0 = sign(0, ax) * (g.origin[ax] + run * g.step[ax]) + c[0];
            const x1 = sign(0, ax) * (g.origin[ax] + a * g.step[ax]) + c[0];
            const y0 = sign(1, ay) * (g.origin[ay] + b * g.step[ay]) + c[1];
            const y1 = sign(1, ay) * (g.origin[ay] + (b + 1) * g.step[ay]) + c[1];
            rects.push(...rect(Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)));
            run = -1;
          }
        }
      }
      // A sample further out: the grid is coarser than the part's walls.
      const r = offset(union(rects), Math.max(g.step[ax], g.step[ay]) * 0.75);
      cache.set(layer, r);
      return r;
    }
  };
  return {
    box: { lo, hi },
    skin: Math.max(...g.step) * 1.6,
    at: (zLo, zHi) => {
      // Every grid layer between the two heights (and the one each is in).
      const [a, b] = [layerOf(zLo), layerOf(zHi)].sort((p, q) => p - q);
      let r: Region = [];
      for (let l = Math.max(0, a); l <= Math.min(g.n[az] - 1, b); l++) r = union(r, layerAt(l));
      return r;
    },
  };
}

/** Face the top from the stock's top down to Z0. */
function facing(fm: CamTool, mat: string, limits: Limits, sb: { lo: Vec; hi: Vec }, cy: number, clear: number): CamOp {
  const cut = cutData(fm, 'face', mat, limits);
  const lines: string[] = [];
  const r = fm.diameter / 2;
  const levels: number[] = [];
  for (let z = sb.hi[2] - cut.ap; z > 0.001; z -= cut.ap) levels.push(z);
  levels.push(0);
  // Passes along the longer side; one when the face mill covers the width, else 70 % of its Ø apart.
  const along = sb.hi[0] - sb.lo[0] >= sb.hi[1] - sb.lo[1] ? 0 : 1;
  const across = 1 - along;
  const span = sb.hi[across] - sb.lo[across];
  const mid = (sb.lo[across] + sb.hi[across]) / 2;
  const count = fm.diameter * 0.8 >= span + 2 ? 1 : Math.ceil((span + 2) / (fm.diameter * 0.7)) + 1;
  const passes = count === 1 ? [mid] : Array.from({ length: count }, (_, i) => sb.lo[across] - 1 + r * 0.6 + (i * (span + 2 - r * 1.2)) / (count - 1));
  const a0 = sb.lo[along] - r - 3;
  const a1 = sb.hi[along] + r + 3;
  const xy = (a: number, b: number) => (along === 0 ? `X${n3(a)} Y${n3(b)}` : `X${n3(b)} Y${n3(a)}`);
  const A = along === 0 ? 'X' : 'Y';
  const B = along === 0 ? 'Y' : 'X';
  lines.push(`G00 G90 ${xy(a0, passes[0])} S${cut.s} M03`);
  for (const z of levels) {
    lines.push(`G00 Z${n3(z + 2)}`, `G01 Z${n3(z)} F${cut.fz}.`);
    passes.forEach((p, i) => {
      if (i) lines.push(`G01 ${B}${n3(p)}`);
      lines.push(`G01 ${A}${n3(i % 2 ? a0 : a1)} F${cut.f}.`);
    });
    lines.push(`G00 Z${n3(clear)}`, `G00 ${xy(a0, passes[0])}`);
  }
  void cy;
  return { kind: 'face', name: 'PLAN', tool: fm, cut, lines };
}

/** Centre-drill, then drill (G83 pecking), one tool after the other. */
function drilling(list: { h: Hole; tool: CamTool; z: number; again?: boolean }[], spot: CamTool | undefined, mat: string, limits: Limits, clear: number): CamOp[] {
  const ops: CamOp[] = [];
  // Holes already there (finished from this side) need no centre.
  const fresh = list.filter((x) => !x.again);
  if (spot && fresh.length) {
    const cut = cutData(spot, 'centre', mat, limits);
    const lines = [`G00 G90 X${n3(fresh[0].h.c[0])} Y${n3(fresh[0].h.c[1])} S${cut.s} M03`, `G00 Z${n3(clear)}`];
    fresh.forEach(({ h }, i) => {
      const z = h.top - Math.min(h.r, spot.diameter / 2) * 0.8;
      lines.push(i ? `X${n3(h.c[0])} Y${n3(h.c[1])} Z${n3(z)} R${n3(h.top + 1)}` : `G98 G81 X${n3(h.c[0])} Y${n3(h.c[1])} Z${n3(z)} R${n3(h.top + 1)} F${cut.fz}.`);
    });
    lines.push('G80');
    ops.push({ kind: 'centre', name: 'ZENTRIERBOHREN', tool: spot, cut, lines });
  }
  const byTool = new Map<CamTool, { h: Hole; z: number }[]>();
  for (const { h, tool, z } of list) (byTool.get(tool) ?? byTool.set(tool, []).get(tool)!).push({ h, z });
  for (const [tool, hs] of byTool) {
    const cut = cutData(tool, 'drill', mat, limits);
    const lines = [`G00 G90 X${n3(hs[0].h.c[0])} Y${n3(hs[0].h.c[1])} S${cut.s} M03`, `G00 Z${n3(clear)}`];
    for (const { h, z } of hs) {
      lines.push(`G98 G83 X${n3(h.c[0])} Y${n3(h.c[1])} Z${n3(z)} R${n3(h.top + 1)} Q${n3(Math.min(cut.q, h.top - z))} F${cut.fz}.`);
    }
    lines.push('G80');
    ops.push({ kind: 'drill', name: `BOHREN_${mm(tool.diameter)}MM`, tool, cut, lines });
  }
  return ops;
}

/**
 * An end mill's rings, level by level, top down. Each ring is run in passes no deeper than the
 * tool's own depth per pass (its ring is clear of the part at every height above its level).
 */
function milling(tool: CamTool, work: { z: number; above: number; rings: Ring[] }[], mat: string, limits: Limits, stockTop: number, clear: number): CamOp {
  const cut = cutData(tool, 'pocket', mat, limits);
  // Round the outside the tool takes at most a step-over of material: the shop's contour depths
  // (much deeper than in a pocket, where the first ring is a full slot).
  const side = cutData(tool, 'contour', mat, limits);
  const first = work[0].rings[0].pts[0];
  const lines = [`G00 G90 X${n3(first[0])} Y${n3(first[1])} S${cut.s} M03`, `G00 Z${n3(clear)}`];
  let prevZ = stockTop;
  for (const { z, above, rings } of work) {
    const top = Math.min(above, prevZ);
    for (const g of rings) {
      const c = g.outside ? side : cut;
      const n = Math.max(1, Math.ceil((top - z) / c.ap - 1e-6));
      const passes = Array.from({ length: n }, (_, i) => top - ((top - z) * (i + 1)) / n);
      const [x, y] = g.pts[0];
      lines.push(`G00 Z${n3(clear)}`, `G00 X${n3(x)} Y${n3(y)}`, `G00 Z${n3(Math.max(z, prevZ) + 1)}`);
      for (const pz of passes) {
        lines.push(`G01 Z${n3(pz)} F${c.fz}.`);
        let fset = false;
        for (const p of [...g.pts.slice(1), ...(g.closed ? [g.pts[0]] : [])]) {
          lines.push(`G01 X${n3(p[0])} Y${n3(p[1])}${fset ? '' : ` F${c.f}.`}`);
          fset = true;
        }
        // An open piece: back to its start above the cut before the next pass.
        if (!g.closed && pz !== passes[passes.length - 1]) lines.push(`G00 Z${n3(pz + 1)}`, `G00 X${n3(x)} Y${n3(y)}`);
      }
    }
    prevZ = z;
  }
  lines.push(`G00 Z${n3(clear)}`);
  return { kind: 'pocket', name: `FRAESEN_${mm(tool.diameter)}MM`, tool, cut, lines };
}

/**
 * The 90° graver's paths for 45° chamfers (setup frame, heights lo..hi): its tip E under the
 * chamfer and E off the wall below it, so its cone lies on the chamfer. Only along the edges
 * that have one, and only where the cone and the shank touch nothing else of the part. Below
 * the jaw limit only inside the part's outline (the stock and jaws are outside there).
 */
function chamferPaths(P: Float32Array, bands: { lo: number; hi: number }[], R: number, jawLimit: number): { z: number; pts: P2[]; top: number }[] {
  const E = 0.3;
  const out: { z: number; pts: P2[]; top: number }[] = [];
  for (const { lo, hi } of bands) {
    const t = lo - E;
    if (hi - t > R) continue; // wider than the graver's cone
    const wall = slice(P, lo - 0.02);
    const band = difference(wall, slice(P, (lo + hi) / 2));
    if (area(band) < 0.05) continue;
    // Where the tool touches more than its chamfer: at each height its cone (or shank) Ø.
    let hit: Region = [];
    for (let z = t + 0.25; z < Math.max(0, hi) + 0.25; z += 0.25) hit = union(hit, offset(slice(P, z), Math.min(R, z - t) - 0.05));
    let where = difference(offset(band, E + 0.3), hit);
    if (t < jawLimit) where = intersection(where, filled(wall));
    const loops = offset(wall, E).map((l) => [...l].reverse());
    for (const pts of trim(loops, where)) if (pts.length > 1) out.push({ z: t, pts, top: hi });
  }
  return out;
}

function chamfering(tool: CamTool, paths: { z: number; pts: P2[]; top: number }[], mat: string, limits: Limits, clear: number): CamOp {
  const cut = cutData(tool, 'chamfer', mat, limits);
  const lines = [`G00 G90 X${n3(paths[0].pts[0][0])} Y${n3(paths[0].pts[0][1])} S${cut.s} M03`];
  for (const { z, pts, top } of paths) {
    // Down over the chamfer's top (clear of the corner it is about to take off), then in.
    lines.push(`G00 Z${n3(clear)}`, `G00 X${n3(pts[0][0])} Y${n3(pts[0][1])}`, `G00 Z${n3(top + 1)}`, `G01 Z${n3(z)} F${cut.fz}.`);
    pts.slice(1).forEach((p, i) => lines.push(`G01 X${n3(p[0])} Y${n3(p[1])}${i ? '' : ` F${cut.f}.`}`));
  }
  lines.push(`G00 Z${n3(clear)}`);
  return { kind: 'chamfer', name: 'FASE', tool, cut, lines };
}

/** How the program does once read back and simulated like the toolpath viewer does it. */
export interface CamCheck {
  /** How alike the simulated part and the model are (0..1), and where they differ. */
  match: number;
  pieces: Piece[];
  minutes: number;
  toolChanges: number;
  /** Tools or holders into the jaws or the part, by the app's own check (these block it). */
  collisions: number;
  /** Spots where a tool goes into a cale under the part (move that cale: a warning). */
  cales: number;
}

export function checkProgram(tris: ArrayLike<number>, code: string, brand?: string, speeds?: MachineSpeeds): CamCheck {
  const tp = parseToolpath(code, speeds ?? speedsFor(brand));
  const an = analyseProgram(tp, { jawHeight: JAW });
  const sim = buildInput(tp, an);
  const laid = sim ? layModel(tris, sim, an.setups) : null;
  const diff = laid && !('mismatch' in laid) ? differences(laid) : null;
  const hits = an.setups.flatMap((x) => x.collisions);
  return {
    match: diff?.match ?? 0,
    pieces: diff?.pieces ?? [],
    minutes: tp.totalSeconds / 60,
    toolChanges: tp.toolChanges,
    // As the remapper: a tool into a cale is a warning (the operator moves the cale), not a hit.
    collisions: hits.filter((h) => h.what !== 'cale' && h.what !== 'spacer').length,
    cales: hits.filter((h) => h.what === 'cale').length,
  };
}

/**
 * The program for a part: planned with each of its sides as the height in the vise (thinnest
 * first), each checked like the toolpath viewer checks it, the right one (99 % like the model, no
 * collision) that takes the least time kept. `progress` after each try.
 */
export function camProgram(input: CamInput, progress: (done: number, of: number) => void = () => {}): CamResult & { check: CamCheck } {
  const b = bounds(input.tris);
  // The operator's layout is planned alone; else each side as the height, thinnest first.
  const order = input.orient ? [SIDES.find((s) => s.name === input.orient!.side)!.d.findIndex((v) => v !== 0)] : [0, 1, 2].sort((p, q) => b.max[p] - b.min[p] - (b.max[q] - b.min[q]));
  let best: (CamResult & { check: CamCheck }) | null = null;
  const good = (c: CamCheck) => c.match >= 0.99 && c.collisions === 0;
  order.forEach((axis, i) => {
    const r = planFor(input, axis);
    const check = checkProgram(input.tris, r.code, input.brand, input.speeds);
    progress(i + 1, order.length);
    const better = !best || (good(check) && (!good(best.check) || check.minutes < best.check.minutes)) || (!good(check) && !good(best.check) && check.match > best.check.match);
    if (better) best = { ...r, check };
  });
  return best!;
}

/** The program with the part's `vertical` model axis as its height in the first two setups. */
function planFor(input: CamInput, vertical: number): CamResult {
  const limits = input.limits ?? DEFAULT_LIMITS;
  const mat = input.material;
  const missing: Need[] = [];
  const notes: CamNote[] = [];
  const needOnce = (n: Need) => {
    if (!missing.some((m) => m.category === n.category && Math.abs(m.diameter - n.diameter) < 0.01)) missing.push(n);
    else {
      const m = missing.find((x) => x.category === n.category && Math.abs(x.diameter - n.diameter) < 0.01)!;
      m.minLength = Math.max(m.minLength, n.minLength);
    }
  };

  // The model centred on its box.
  const b0 = bounds(input.tris);
  const c0: Vec = [0, 1, 2].map((k) => -(b0.min[k] + b0.max[k]) / 2) as Vec;
  const tris = turnTris(input.tris, IDENTITY, c0);
  const size = [0, 1, 2].map((k) => b0.max[k] - b0.min[k]) as Vec;
  // Raw: the thinnest side gets the thickness allowance, the others the side allowance.
  const order = [0, 1, 2].sort((a, b) => size[a] - size[b]);
  const allow = knowledge.allowance ?? [10, 4, 4];
  const raw: Vec = input.raw ?? (size.map((s, k) => s + allow[order.indexOf(k)]) as Vec);
  const rawLo = raw.map((v) => -v / 2) as Vec;
  const rawHi = raw.map((v) => v / 2) as Vec;

  // Sides: the two faces of the chosen height, then whichever reaches most of what is left.
  // The operator's layout: its side first (then the opposite one), both turned as chosen.
  const first = input.orient ? SIDES.findIndex((s) => s.name === input.orient!.side) : -1;
  const thin = first >= 0 ? SIDES[first].d.findIndex((v) => v !== 0) : vertical;
  const { occ, reach, cell, grid } = reachable(tris, rawLo, rawHi);
  const covered = new Uint8Array(occ.length);
  const chosen: number[] = [];
  const take = (si: number) => {
    chosen.push(si);
    for (let i = 0; i < occ.length; i++) if (reach[si][i]) covered[i] = 1;
  };
  const spun = (si: number) => first >= 0 && !!input.orient?.spin && SIDES[si].d[thin] !== 0;
  const feats = SIDES.map((s, si) => sideFeatures(tris, s, spun(si)));
  // The simpler face first (fewer floors and holes), the finished front last of the two.
  const [a, bSide] = [sideOf(thin, 1), sideOf(thin, -1)];
  const busy = (si: number) => feats[si].floors.length + feats[si].holes.length;
  for (const si of first >= 0 ? [first, first === a ? bSide : a] : busy(a) <= busy(bSide) ? [a, bSide] : [bSide, a]) take(si);
  for (;;) {
    let best = -1;
    let gain = 0;
    for (let si = 0; si < 6; si++) {
      if (chosen.includes(si)) continue;
      let g = 0;
      for (let i = 0; i < occ.length; i++) if (reach[si][i] && !covered[i] && !occ[i]) g++;
      if (g > gain) [best, gain] = [si, g];
    }
    if (best < 0 || gain * cell < 2) break;
    take(best);
  }
  let left = 0;
  for (let i = 0; i < occ.length; i++) if (!occ[i] && !covered[i]) left++;
  if (left * cell > 2) notes.push({ key: 'undercut', mm3: Math.round(left * cell) });

  // Holes drilled so far, with how much of their far end is still narrow (0: done).
  const drilled = new Map<string, number>();
  const setups: CamSetup[] = [];
  let prevR: Mat3 | null = null;
  // The shop's template tools for this material, plus the machine's special ones (machine's first).
  const tools = catalog(mat, input.tools, input);
  const mills = usable(tools, MILLS);
  const addSetup = (si: number): boolean => {
    const side = SIDES[si];
    const f = feats[si];
    const R = f.R;
    const top = f.max[2];
    const t: Vec = [0, 0, -top];
    const P = turnTris(tris, R, t);
    // What is left of the part now, in this setup's frame: the raw box, or what the setups before
    // really left (simulated like the toolpath viewer does).
    const left = setups.length ? remaining(input, setups, size, raw, R, t) : boxLeft(R, t, rawLo, rawHi);
    if (!left) {
      notes.push({ key: 'notSimulated', side: side.name });
      return false;
    }
    const sb = left.box;
    const H = f.max[2] - f.min[2];
    const stockH = sb.hi[2] - sb.lo[2];
    // Grip only what is below the part (and as little of it as holds): the outside is cut down to its bottom.
    const { cale, grip } = caleFor(stockH, -H - 0.5 - sb.lo[2]);
    const jawTop = sb.lo[2] + grip;
    const floor = sb.lo[2] - cale;
    const hold: [number, number] = [sb.hi[0] - sb.lo[0], sb.hi[1] - sb.lo[1]];
    const cx = (sb.lo[0] + sb.hi[0]) / 2;
    const cy = (sb.lo[1] + sb.hi[1]) / 2;
    const shift: Vec = [STOP_X + hold[0] / 2 - cx, STOP_Y - hold[1] / 2 - cy, TABLE_Z - floor];
    const turn = prevR ? turnPhrase(mul(R, transpose(prevR))) : '';
    const sizes = `${mm(hold[0])} IN X UND ${mm(hold[1])} IN Y`;
    // "Z+ IN 2MM": the raw top that far above Z0 (what the facing takes off), as the shop writes it.
    const raised = sb.hi[2] > 0.01 ? `/Z+ IN ${mm(sb.hi[2])}MM` : '';
    const setupNotes = [`${prevR ? (turn ? `${turn}/${sizes}` : sizes) : `TEIL MIT ${sizes} EINSPANNEN`}${raised}`, `${cale} MM UNTERLAGE`];
    // Too long for one vise: both, as the checker reads it back (setups.ts).
    if (hold[0] > VISE.width + OVERHANG) setupNotes.push(`MIT 2 SCHRAUBSTOECKEN ${VISE.gap} MM ABSTAND`);
    const ops: CamOp[] = [];
    const clear = Math.max(sb.hi[2], 0) + 2;

    // 1. Face the top (the face mill, else the largest end mill).
    if (sb.hi[2] > 0.01) {
      const fm = usable(tools, ['MK'])[0] ?? mills[0];
      if (!fm) needOnce({ category: 'tourteau', diameter: 50, minLength: 0, why: { key: 'face' } });
      else ops.push(facing(fm, mat, limits, sb, cy, clear));
    }

    // 2. Holes from this side: drilled when the inventory has the drill, else milled with the rest.
    const holes = f.holes.map((h) => ({ ...h, top: h.top - top, bottom: h.bottom - top }));
    const keyOf = (h: Hole) => {
      const c = apply(transpose(R), [h.c[0], h.c[1], 0]);
      const axis = apply(transpose(R), [0, 0, 1]).findIndex((v) => v !== 0);
      return `${axis}:${c.map((v, k) => (k === axis ? 0 : Math.round(v * 20))).join(',')}:${Math.round(h.r * 40)}`;
    };
    const drills = usable(tools, ['SB']);
    // The drill of that Ø, else the nearest within 0.12 (as the shop does: Ø2.05 with Ø2, Ø3.2 with Ø3.3).
    const drillFor = (h: Hole, depth: number) =>
      drills.filter((x) => Math.abs(x.diameter - h.r * 2) <= 0.12 && (x.length || 99) >= depth + 2).sort((p, q) => Math.abs(p.diameter - h.r * 2) - Math.abs(q.diameter - h.r * 2))[0];
    const toDrill: { h: Hole; tool: CamTool; z: number; again?: boolean }[] = [];
    const keepHoles: Hole[] = [];
    for (const h of holes) {
      const k = keyOf(h);
      const depth = h.top - h.bottom + (h.through ? 0.3 * h.r * 2 + 0.5 : 0);
      const lip = drilled.get(k);
      if (lip !== undefined) {
        keepHoles.push(h);
        // The far end the setup before left narrow (its drill stopped in the stock, over the
        // cales): finished from this side, into the hole already there.
        const d = lip > 0 && h.through ? drillFor(h, lip + h.r + 1) : undefined;
        if (d) {
          toDrill.push({ h, tool: d, z: h.top - lip - 0.3 * d.diameter - 0.5, again: true });
          drilled.set(k, 0);
        }
        continue;
      }
      const d = drillFor(h, depth);
      if (d) {
        // Through the part but not through the stock under it: the cales are there. What that
        // leaves narrow at the far end is drilled from the other side.
        let z = h.through ? h.bottom - (0.3 * d.diameter + 0.5) : h.bottom;
        let rest = 0;
        if (h.through && z < sb.lo[2] + 0.1) {
          z = sb.lo[2] + 0.1;
          rest = Math.max(0, z + 0.3 * d.diameter - h.bottom);
        }
        toDrill.push({ h, tool: d, z });
        keepHoles.push(h);
        drilled.set(k, rest);
      } else {
        // No drill: milled when an end mill fits (slower); the drill is listed either way.
        const millable = mills.length && mills[mills.length - 1].diameter <= h.r * 2 - 0.2;
        needOnce({ category: 'foret', diameter: Math.round(h.r * 200) / 100, minLength: Math.ceil(depth + 2), why: { key: millable ? 'holeMilled' : 'hole', d: Math.round(h.r * 200) / 100, depth: Math.round((h.top - h.bottom) * 10) / 10 } });
        if (!millable) {
          keepHoles.push(h);
          drilled.set(k, 0);
        }
      }
    }
    if (toDrill.length) ops.push(...drilling(toDrill, usable(tools, ['ZB'])[0] ?? usable(tools, ['AB'])[0], mat, limits, clear));

    // 3. Milling level by level: the largest end mill, then smaller ones only where it could not reach.
    const floors = f.floors.map((x) => x.z - top).filter((z) => z < -0.005 && z > -H - 0.01);
    const bottom = -H - 0.2;
    // Also a level at the jaw limit: the outside is cut down to there, never lower.
    const jawLimit = jawTop + 0.5;
    const stops = [...new Set([...floors, bottom, ...(jawLimit < 0 && jawLimit > bottom ? [jawLimit] : [])])].sort((p, q) => q - p);
    const maxAp = mills.length ? cutData(mills[0], 'contour', mat, limits).ap : 2;
    const levels: number[] = [];
    let from = Math.min(0, sb.hi[2]);
    for (const st of stops) {
      if (st > from) continue;
      const n = Math.max(1, Math.ceil((from - st) / maxAp - 1e-6));
      for (let i = 1; i <= n; i++) levels.push(from - ((from - st) * i) / n);
      from = st;
    }
    // What stays at a level: everything of the part above it (sampled every 0.5 mm and at every
    // floor, so a hole running across is not taken for a pocket) and the holes drilled.
    const samples = [...new Set([...Array.from({ length: Math.ceil(H / 0.5) + 1 }, (_, i) => -i * 0.5), ...floors.flatMap((z) => [z + 0.002, z - 0.002])])].filter((z) => z <= 0 && z >= -H).sort((p, q) => q - p);
    let above: Region = [];
    let si2 = 0;
    const keepAt = (z: number): Region => {
      while (si2 < samples.length && samples[si2] > z + 0.001) above = union(above, slice(P, samples[si2++]));
      let k = union(above, slice(P, z + 0.001));
      const disks = keepHoles.filter((h) => h.top > z + 0.001 && h.bottom < z).map((h) => circle(h.c, h.r));
      if (disks.length) k = union(k, disks);
      return k;
    };
    const perTool = new Map<CamTool, { z: number; above: number; rings: Ring[] }[]>();
    let narrow = 0;
    let narrowDepth = 0;
    let zAbove = Math.max(sb.hi[2], 0);
    for (const z of levels) {
      const keep = keepAt(z);
      // All the material between this level and the one above: the side of the tool takes it.
      // Thinner than the simulation's grid next to the part is the grid, not material.
      let todo = difference(left.at(z, zAbove), left.skin ? offset(keep, left.skin) : keep);
      const levelTop = zAbove;
      zAbove = z;
      const inside = z < jawLimit - 0.001;
      if (inside) todo = intersection(todo, filled(keep));
      todo = opened(todo);
      // The largest end mill first. Then, on what it left (corners, narrow pockets), the largest
      // one that takes most of it (80 %): the sizes in between would only add tool changes. A
      // small tool on open ground is the slowest program there is.
      // Long enough from the stock's top, 2 mm to spare for the holder.
      let cands = mills.filter((m) => (m.length || 99) >= Math.max(0, sb.hi[2]) - z + 2);
      for (let round = 0; round < 6 && cands.length && area(todo) > 0.5; round++) {
        const all = area(todo);
        let pick: { tool: CamTool; rings: Ring[]; gone: Region; share: number } | null = null;
        for (const tool of cands) {
          const cut = cutData(tool, 'pocket', mat, limits);
          const rings = clearLevel(keep, todo, tool.diameter / 2, cut.ae, inside);
          if (!rings.length) continue;
          const gone = swept(rings, tool.diameter / 2);
          const share = area(intersection(todo, gone)) / all;
          if (!pick || share > pick.share + 0.02) pick = { tool, rings, gone, share };
          if (round === 0 || share >= 0.8) break;
        }
        if (!pick) break;
        // Smaller tools only from here on (a bigger one cannot do better on what is left).
        cands = cands.filter((m) => m.diameter < pick!.tool.diameter);
        // A tool not used yet in this setup must take enough to be worth its tool change.
        if (!perTool.has(pick.tool) && pick.share * all < 0.5) continue;
        (perTool.get(pick.tool) ?? perTool.set(pick.tool, []).get(pick.tool)!).push({ z, above: levelTop, rings: pick.rings });
        todo = opened(difference(todo, pick.gone));
      }
      // What no end mill here could reach: listed once it adds up to more than slivers.
      if (area(todo) > 0.5) {
        narrow += area(todo) * (levelTop - z);
        narrowDepth = Math.max(narrowDepth, -z);
      }
    }
    if (narrow > 5) needOnce({ category: 'fraise', diameter: mills.length ? Math.max(1, Math.floor(mills[mills.length - 1].diameter / 2)) : 6, minLength: Math.ceil(narrowDepth + 2), why: { key: 'narrow', mm3: Math.round(narrow) } });
    // One tool per Ø in a setup: the longest one needed does all the levels of that Ø (one tool
    // change instead of two; the levels stay top down).
    const byDia = new Map<number, CamTool[]>();
    for (const tool of perTool.keys()) (byDia.get(tool.diameter) ?? byDia.set(tool.diameter, []).get(tool.diameter)!).push(tool);
    for (const tool of mills) {
      const same = byDia.get(tool.diameter);
      if (!same?.includes(tool) || same.some((o) => o.length > tool.length)) continue;
      const work = same.flatMap((o) => perTool.get(o)!).sort((p, q) => q.z - p.z);
      ops.push(milling(tool, work, mat, limits, sb.hi[2], clear));
    }
    // 4. Chamfers on the edges facing up, with the 90° graver.
    if (f.chamfers.length) {
      const graver = usable(tools, ['ST']).find((t) => t.template?.shape === 'G45' || !t.template);
      const paths = graver ? chamferPaths(P, f.chamfers.map((c) => ({ lo: c.lo - top, hi: c.hi - top })), graver.diameter / 2, jawLimit) : [];
      if (!graver) needOnce({ category: 'chanfrein', diameter: 4, minLength: 25, why: { key: 'chamfer', count: f.chamfers.length } });
      else if (paths.length) ops.push(chamfering(graver, paths, mat, limits, clear));
    }
    if (f.freeform > 20) notes.push({ key: 'surface', side: side.name, mm2: Math.round(f.freeform) });

    // Nothing to do from this side after all: no setup.
    if (!ops.length) return false;
    setups.push({ side: side.name, R, t, notes: setupNotes, shift, cale, ops });
    prevR = R;
    return true;
  };
  for (const si of chosen) addSetup(si);
  // Material still there that should not be (under the jaws, out of a tool's reach): one more
  // setup from the unused side that reaches most of it, simulated again, at most three more.
  // Cells touching the part are left out: the two grids never quite agree there (a skin of
  // cells all round the part, not material left).
  const near = grown(occ, grid.n);
  for (let extra = 0; extra < 3 && setups.length; extra++) {
    const g = simulate(input, setups, size, raw);
    if (!g) break;
    const R1 = setups[0].R;
    const t1 = setups[0].t;
    const gain = SIDES.map(() => 0);
    const { n: rn, origin: ro, step: rs } = grid;
    for (let i = 0; i < occ.length; i++) {
      if (near[i]) continue;
      const ix = i % rn[0];
      const iy = Math.floor(i / rn[0]) % rn[1];
      const iz = Math.floor(i / (rn[0] * rn[1]));
      const q = apply(R1, [ro[0] + (ix + 0.5) * rs[0], ro[1] + (iy + 0.5) * rs[1], ro[2] + (iz + 0.5) * rs[2]]);
      const c = [0, 1, 2].map((k) => Math.floor((q[k] + t1[k] - g.origin[k]) / g.step[k]));
      if (c.some((v, k) => v < 0 || v >= g.n[k])) continue;
      if (g.removed[c[2] * g.n[0] * g.n[1] + c[1] * g.n[0] + c[0]] !== KEPT) continue;
      for (let si = 0; si < 6; si++) if (reach[si][i]) gain[si]++;
    }
    const best = gain.map((v, si) => ({ v, si })).filter((x) => !setups.some((st) => st.side === SIDES[x.si].name)).sort((a2, b2) => b2.v - a2.v)[0];
    if (!best || best.v * cell < 5) break;
    if (!addSetup(best.si)) break;
  }

  return { code: post(input, setups, size, raw), setups, missing, notes, size, raw };
}

/** The program text, like the shop's. */
function post(input: CamInput, setups: CamSetup[], size: Vec, raw: Vec): string {
  const s0 = setups[0];
  const fin = apply(s0?.R ?? IDENTITY, size).map(Math.abs);
  const rw = apply(s0?.R ?? IDENTITY, raw).map(Math.abs);
  const d = new Date();
  const date = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getFullYear()).slice(2)}`;
  const out: string[] = [
    '(CAM AI)',
    `(DATUM DER ERSTELLUNG: ${date} / BEARBEITER: CAM AI)`,
    `(${(input.name ?? 'TEIL').toUpperCase()} ${input.material} / ${fin.map(mm).join('X')} / ZUSCHNITT:${rw.map(mm).join('X')})`,
    '(ERSTES TEIL MIT REDUZIERTEM VORSCHUB FAHREN)',
    'G40 G17 G53 G49 G80 G90',
    'G54',
  ];
  for (const s of setups) {
    out.push('G53 Y0', ...s.notes.map((n) => `M0 (${n})`), `G52 X${n3(s.shift[0])} Y${n3(s.shift[1])} Z${n3(s.shift[2])}`);
    for (const op of s.ops) {
      const t = op.tool;
      out.push(
        'M09',
        `(TOOLPATH ${op.name})`,
        `T${t.number} M6`,
        `(${toolComment(t)})`,
        `(DIAMETER ${t.diameter.toFixed(2)} MM/LENGTH ${(t.length || 0).toFixed(2)} MM)`,
        'M01 (CHECK TOOL)',
        `G00 G43 H${String(t.number).padStart(2, '0')} Z${SAFE}. M08`,
        ...op.lines,
        `G00 Z${SAFE}.`,
      );
    }
  }
  out.push('M09', 'G53 Y0', 'M30');
  return ['%', `O${String(input.number ?? 1).padStart(4, '0')}`, ...out.map((l, i) => `N${i + 1} ${l}`), '%'].join('\n');
}

/** Every turn the part can lie (for the check). */
export const TURNS = ALL;
