import type { Vec } from './toolpath';
import type { SetupInfo } from './setups';
import { carve, KEPT, materialExtreme, type Grid, type SimInput } from './stockSim';
import { ALL, apply, transpose, turnedBox, type Mat3 } from './orient';

/*
 * The real part (a model from its 3D PDF or STL) laid on the simulated part, and what each setup's
 * cuts do to it. Shared by the viewer (import a model) and tools/stl-blame.ts.
 */

/** Less finished material cut than this (mm³) is the simulation's own roughness, not a mistake. */
export const NOISE = 15;

/** What some cuts do to the real part: finished material cut (wrong) and waste cut (right), mm³. */
export interface Way {
  mm3: number;
  waste: number;
}
/** Waste cut is the job, finished material cut is ten times as bad (a way cutting only air scores nothing). */
export const score = (w: Way) => w.waste - 10 * w.mm3;
export const worse = (p: Way, q: Way) => score(p) < score(q) - Math.max(10 * NOISE, Math.abs(score(q)) * 0.05);

export type Placed = Pick<SetupInfo, 'index' | 'orient' | 'offset' | 'stock'>;

/** Which sample centres of grid g are inside the model placed by p -> R p + t (parity of crossings along Z). */
export function voxelize(tris: ArrayLike<number>, R: Mat3, t: Vec, g: Grid): Uint8Array {
  const [nx, ny, nz] = g.n;
  const hits: number[][] = Array.from({ length: nx * ny }, () => []);
  const P: Vec[] = [];
  for (let i = 0; i < tris.length; i += 3) {
    const q = apply(R, [tris[i], tris[i + 1], tris[i + 2]]);
    P.push([q[0] + t[0], q[1] + t[1], q[2] + t[2]]);
  }
  for (let f = 0; f < P.length; f += 3) {
    const [a, b, c] = [P[f], P[f + 1], P[f + 2]];
    const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(den) < 1e-12) continue;
    const i0 = Math.max(0, Math.ceil((Math.min(a[0], b[0], c[0]) - g.origin[0]) / g.step[0] - 0.5));
    const i1 = Math.min(nx - 1, Math.floor((Math.max(a[0], b[0], c[0]) - g.origin[0]) / g.step[0] - 0.5));
    const j0 = Math.max(0, Math.ceil((Math.min(a[1], b[1], c[1]) - g.origin[1]) / g.step[1] - 0.5));
    const j1 = Math.min(ny - 1, Math.floor((Math.max(a[1], b[1], c[1]) - g.origin[1]) / g.step[1] - 0.5));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const x = g.origin[0] + (i + 0.5) * g.step[0];
        const y = g.origin[1] + (j + 0.5) * g.step[1];
        const u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / den;
        const v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / den;
        if (u >= 0 && v >= 0 && u + v <= 1) hits[j * nx + i].push(u * a[2] + v * b[2] + (1 - u - v) * c[2]);
      }
  }
  const occ = new Uint8Array(nx * ny * nz);
  hits.forEach((h, col) => {
    h.sort((p, q) => p - q);
    const z = h.filter((v, n) => n === 0 || v - h[n - 1] > 1e-7);
    for (let n = 0; n + 1 < z.length; n += 2)
      for (let k = 0; k < nz; k++) {
        const pz = g.origin[2] + (k + 0.5) * g.step[2];
        if (pz > z[n] && pz < z[n + 1]) occ[k * nx * ny + col] = 1;
      }
  });
  return occ;
}

/** The model laid on the simulated part. */
export interface ModelFit {
  /** Model point p goes to R p + t in the part frame. */
  R: Mat3;
  t: Vec;
  /** Share of the model and the simulated finished part that coincide (0..1). */
  overlap: number;
  /** The simulated finished part's size (mm). */
  size: Vec;
  g: Grid;
  occ: Uint8Array;
  /** What setup s's tools cut of the model with the part lying as O, shifted by d (machine mm). */
  cutInto: (s: Placed, O: Mat3, d?: Vec) => Way;
}

/**
 * Lay the model (triangles, mm) on the simulated finished part: turned every quarter-turn way that
 * has the simulated part's size, centred on it. Setup 1 is the part's own frame, so it must cut no
 * finished material; of the ways where it does not, the one where model and simulation overlap most.
 * `mismatch` when no way has the simulated part's size (another part, or another unit).
 */
export function layModel(tris: ArrayLike<number>, input: SimInput, setups: Placed[], voxels = 300_000): ModelFit | { mismatch: { model: Vec; part: Vec } } {
  const base: SimInput = { ...input, maxVoxels: voxels, surfaceMoves: false };
  const g = carve(base);
  const ext = ([0, 1, 2] as const).map((a) => [materialExtreme(base, g, base.moves.length, a, -1) ?? 0, materialExtreme(base, g, base.moves.length, a, 1) ?? 0]);
  const size = ext.map(([lo, hi]) => hi - lo) as Vec;
  const mid = ext.map(([lo, hi]) => (lo + hi) / 2) as Vec;
  const lo: Vec = [Infinity, Infinity, Infinity];
  const hi: Vec = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) for (let k = 0; k < 3; k++) [lo[k], hi[k]] = [Math.min(lo[k], tris[i + k]), Math.max(hi[k], tris[i + k])];
  const own: Vec = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2) as Vec;
  const vol = g.step[0] * g.step[1] * g.step[2];

  const cutWith = (occ: Uint8Array) => (s: Placed, O: Mat3, d: Vec = [0, 0, 0]): Way => {
    // Placed like the app places it: against the stop (X-), the fixed jaw (Y+), its top where the app has it.
    const stock = s.stock!;
    const box = turnedBox(transpose(s.orient), stock.min.map((v, k) => v - s.offset[k]) as Vec, stock.max.map((v, k) => v - s.offset[k]) as Vec);
    const tb = turnedBox(O, box.min, box.max);
    const t: Vec = [stock.min[0] - tb.min[0] + d[0], stock.max[1] - tb.max[1] + d[1], stock.max[2] - tb.max[2] + d[2]];
    const moves = base.moves.map((m) => (m.setup === s.index ? { ...m, setup: 0 } : { ...m, points: [] }));
    const cut = carve({ ...base, moves, setups: [{ orient: O, offset: t }], dropLoose: false });
    let bad = 0;
    let good = 0;
    for (let v = 0; v < occ.length; v++) if (cut.removed[v] !== KEPT) occ[v] ? bad++ : good++;
    return { mm3: bad * vol, waste: good * vol };
  };

  const fits = ALL.filter((R) => {
    const b = turnedBox(R, lo, hi);
    return [0, 1, 2].every((k) => Math.abs(b.max[k] - b.min[k] - size[k]) < Math.max(1.5, size[k] * 0.05));
  });
  if (!fits.length) return { mismatch: { model: hi.map((v, k) => v - lo[k]) as Vec, part: size } };
  const first = setups.find((s) => s.stock);
  let best: (ModelFit & { firstWay: Way }) | null = null;
  for (const R of fits) {
    const c = apply(R, own);
    const t: Vec = [mid[0] - c[0], mid[1] - c[1], mid[2] - c[2]];
    const occ = voxelize(tris, R, t, g);
    let both = 0;
    let either = 0;
    for (let v = 0; v < occ.length; v++) {
      const sim = g.removed[v] === KEPT;
      if (sim && occ[v]) both++;
      if (sim || occ[v]) either++;
    }
    const cutInto = cutWith(occ);
    const firstWay = first ? cutInto(first, first.orient) : { mm3: 0, waste: 0 };
    const overlap = either ? both / either : 0;
    if (!best || worse(best.firstWay, firstWay) || (!worse(firstWay, best.firstWay) && overlap > best.overlap)) best = { R, t, overlap, size, g, occ, cutInto, firstWay };
  }
  return best!;
}

/** The model's triangles moved into the part frame. */
export function placeModel(tris: ArrayLike<number>, R: Mat3, t: Vec): Float32Array {
  const out = new Float32Array(tris.length);
  for (let i = 0; i < tris.length; i += 3) {
    const q = apply(R, [tris[i], tris[i + 1], tris[i + 2]]);
    out[i] = q[0] + t[0];
    out[i + 1] = q[1] + t[1];
    out[i + 2] = q[2] + t[2];
  }
  return out;
}

/** A place where the simulated part and the model differ. */
export interface Piece {
  /** left: the simulation keeps material the model does not have (an operation missing or short); cut: it cuts material the model has. */
  kind: 'left' | 'cut';
  mm3: number;
  /** Its box in the part frame (mm). */
  min: Vec;
  max: Vec;
  /** cut: the move that cut most of it. */
  move: number | null;
}

/**
 * Where the simulated finished part and the laid model differ, and how alike they are (match,
 * 0..1: the share of the model's volume not in a difference). A sample counts only where its six
 * neighbours differ the same way: the one-sample skin where the sampled surface and the model's
 * flat facets disagree is not a difference. Pieces under `minMm3` are dropped.
 */
export function differences(fit: Pick<ModelFit, 'g' | 'occ'>, minMm3 = 2): { match: number; pieces: Piece[] } {
  const { g, occ } = fit;
  const [nx, ny, nz] = g.n;
  const S = nx * ny;
  const N = S * nz;
  const vol = g.step[0] * g.step[1] * g.step[2];
  const cls = new Uint8Array(N);
  let model = 0;
  for (let v = 0; v < N; v++) {
    const sim = g.removed[v] === KEPT;
    if (occ[v]) model++;
    cls[v] = sim && !occ[v] ? 1 : !sim && occ[v] ? 2 : 0;
  }
  const near = (v: number, f: (w: number) => void) => {
    const i = v % nx;
    const j = Math.floor(v / nx) % ny;
    const k = Math.floor(v / S);
    if (i > 0) f(v - 1);
    if (i < nx - 1) f(v + 1);
    if (j > 0) f(v - nx);
    if (j < ny - 1) f(v + nx);
    if (k > 0) f(v - S);
    if (k < nz - 1) f(v + S);
  };
  const core = new Uint8Array(N);
  for (let v = 0; v < N; v++) {
    if (!cls[v]) continue;
    let n = 0;
    near(v, (w) => cls[w] === cls[v] && n++);
    if (n === 6) core[v] = 1;
  }
  const seen = new Uint8Array(N);
  const pieces: Piece[] = [];
  for (let s = 0; s < N; s++) {
    if (!core[s] || seen[s]) continue;
    // The core's connected samples, then the skin round them (one sample out).
    const list = [s];
    seen[s] = 1;
    for (let q = 0; q < list.length; q++)
      near(list[q], (w) => {
        if (core[w] && !seen[w] && cls[w] === cls[s]) {
          seen[w] = 1;
          list.push(w);
        }
      });
    const skin = new Set<number>();
    for (const v of list) near(v, (w) => cls[w] === cls[s] && !core[w] && skin.add(w));
    const all = [...list, ...skin];
    const mm3 = all.length * vol;
    if (mm3 < minMm3) continue;
    const min: Vec = [Infinity, Infinity, Infinity];
    const max: Vec = [-Infinity, -Infinity, -Infinity];
    const moves = new Map<number, number>();
    for (const v of all) {
      const c = [v % nx, Math.floor(v / nx) % ny, Math.floor(v / S)];
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], g.origin[k] + c[k] * g.step[k]);
        max[k] = Math.max(max[k], g.origin[k] + (c[k] + 1) * g.step[k]);
      }
      if (cls[s] === 2) moves.set(g.removed[v], (moves.get(g.removed[v]) ?? 0) + 1);
    }
    const move = cls[s] === 2 ? [...moves].reduce((a, b) => (b[1] > a[1] ? b : a))[0] : null;
    pieces.push({ kind: cls[s] === 1 ? 'left' : 'cut', mm3, min, max, move });
  }
  pieces.sort((a, b) => b.mm3 - a.mm3);
  const wrong = pieces.reduce((t, p) => t + p.mm3, 0);
  return { match: model ? Math.max(0, 1 - wrong / (model * vol)) : 0, pieces };
}
