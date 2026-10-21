import type { Toolpath, Vec } from './toolpath';
import type { Mat3 } from './orient';
import type { ProgramSetups } from './setups';

/*
 * The part as a fine grid of sample points in its own frame. Every cutting move takes away the
 * points the tool sweeps through; each point remembers which move took it away, so the part can
 * be shown at any point of the program without cutting again.
 *
 * The surface is not drawn as little cubes: where solid meets cut, the exact edge of the tool
 * that cut it is found (and which way it faces), and a surface is fitted through those points
 * (dual contouring). Flat faces stay flat, corners stay sharp, round walls are round.
 *
 * Tools are flat-bottomed cylinders pointing down (−Z on the machine), except 90° chamfer tools
 * (STICHEL / FASE / G45), which are cones. Rapid moves do not cut.
 */

export const KEPT = 0x7fffffff;
/** How long the part takes to turn between setups in the 3D view (ms). */
export const FLIP_MS = 1300;

export interface SimTool {
  tool: number | null;
  radius: number;
  cone: boolean;
}

export interface SimInput {
  /** Cutting moves as polylines (machine coordinates of their setup). */
  moves: { setup: number; tool: number | null; points: Vec[] }[];
  setups: { orient: Mat3; offset: Vec }[];
  part: { min: Vec; max: Vec };
  tools: SimTool[];
  /** Upper limit of sample points (memory and time). */
  maxVoxels?: number;
}

export interface Grid {
  n: [number, number, number];
  /** Spacing of the sample points along X, Y, Z (they fill the part box exactly). */
  step: Vec;
  /** Average spacing. */
  size: number;
  origin: Vec;
  removed: Int32Array;
}

/** Moves of a parsed program, ready to cut (drilling becomes a straight plunge). */
export function simMoves(tp: Toolpath): SimInput['moves'] {
  return tp.moves.map((m) =>
    m.kind === 'rapid'
      ? { setup: m.setup, tool: m.tool, points: [] }
      : { setup: m.setup, tool: m.tool, points: m.kind === 'drill' ? [m.points[0], [m.points[0][0], m.points[0][1], m.depth ?? m.points[0][2]]] : m.points },
  );
}

export function simTools(tp: Toolpath): SimTool[] {
  return tp.tools.map((t) => ({
    tool: t.tool,
    radius: Math.max(0.3, (t.diameter ?? guessDiameter(t.label)) / 2),
    cone: /STICHEL|FASE|G45|SENKER|CHAMFER/i.test(t.label),
  }));
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
export function sweeps(x: number, y: number, z: number, a: Vec, b: Vec, r: number, cone: boolean): boolean {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const wx = x - a[0];
  const wy = y - a[1];
  const l2 = dx * dx + dy * dy;
  if (!cone) {
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
  // Cone (45°): radius at height h above the tip is min(r, h). Check the likely positions.
  const us = l2 < 1e-12 ? [dz < 0 ? 1 : 0] : [0, 1, Math.min(1, Math.max(0, (wx * dx + wy * dy) / l2))];
  for (const u of us) {
    const ex = wx - u * dx;
    const ey = wy - u * dy;
    const d = Math.sqrt(ex * ex + ey * ey);
    const h = z - (a[2] + u * dz);
    if (h >= -1e-9 && d <= Math.min(r, h) + 1e-9) return true;
  }
  return false;
}

/** Which way the surface left by a sweep faces at machine point p (out of the material). */
function sweepNormal(p: Vec, a: Vec, b: Vec, r: number, cone: boolean, tol: number): Vec {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let u = l2 > 1e-12 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
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
  if (cone) {
    if (d < 1e-6) return [0, 0, 1];
    const n = Math.SQRT1_2;
    return [ix * n, iy * n, n];
  }
  // Bottom of the tool (the point is inside the disc, far from its rim): the floor faces up.
  if (d < r - tol || d < 1e-6) return [0, 0, 1];
  return [ix, iy, 0];
}

/* ---------- Cutting ---------- */

export function carve(input: SimInput, onProgress?: (share: number) => void): Grid {
  const { part } = input;
  const ext: Vec = [part.max[0] - part.min[0], part.max[1] - part.min[1], part.max[2] - part.min[2]];
  const maxVoxels = input.maxVoxels ?? 1_500_000;
  const target = Math.max(0.12, Math.cbrt((ext[0] * ext[1] * ext[2]) / maxVoxels));
  const n: [number, number, number] = [Math.max(2, Math.round(ext[0] / target)), Math.max(2, Math.round(ext[1] / target)), Math.max(2, Math.round(ext[2] / target))];
  // Samples sit in the middle of equal slices of the part box, so its faces fall halfway between.
  const step: Vec = [ext[0] / n[0], ext[1] / n[1], ext[2] / n[2]];
  const origin: Vec = [...part.min];
  const removed = new Int32Array(n[0] * n[1] * n[2]).fill(KEPT);
  const toolOf = new Map(input.tools.map((t) => [t.tool, t]));
  const [nx, ny, nz] = n;

  input.moves.forEach((mv, index) => {
    if (onProgress && index % 500 === 0) onProgress(index / input.moves.length);
    if (mv.points.length < 2) return;
    const s = input.setups[mv.setup];
    if (!s) return;
    const R = s.orient;
    const t = s.offset;
    const tool = toolOf.get(mv.tool) ?? { tool: mv.tool, radius: 3, cone: false };
    const r = tool.radius;
    for (let q = 1; q < mv.points.length; q++) {
      const a = mv.points[q - 1];
      const b = mv.points[q];
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
      if (i0 > i1 || j0 > j1 || k0 > k1) continue;
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
            if (sweeps(mx, my, mz, a, b, r, tool.cone)) removed[v] = index;
          }
        }
      }
    }
  });
  onProgress?.(1);
  return { n, step, size: Math.cbrt(step[0] * step[1] * step[2]), origin, removed };
}

/* ---------- Surfaces ---------- */

export const CHUNK = 24;

export interface ChunkMesh {
  id: number;
  positions: Float32Array;
  normals: Float32Array;
  /** 1 = a cut surface, 0 = an outside surface of the raw part. */
  cut: Uint8Array;
}

export interface Mesher {
  chunks: number;
  /** Chunks whose surface differs between two points of the program. */
  dirty(from: number, to: number): number[];
  build(id: number, step: number): ChunkMesh;
}

interface Cross {
  p: Vec;
  n: Vec;
  cut: boolean;
}

export function mesher(g: Grid, input: SimInput): Mesher {
  const [nx, ny, nz] = g.n;
  const { origin, step: h } = g;
  const cx = Math.ceil((nx + 1) / CHUNK);
  const cy = Math.ceil((ny + 1) / CHUNK);
  const cz = Math.ceil((nz + 1) / CHUNK);
  const count = cx * cy * cz;
  const toolOf = new Map(input.tools.map((t) => [t.tool, t]));

  // Cells are numbered from -1 (outside the part) so chunk a holds cells a*CHUNK-1 ...
  const chunkOf = (c: number) => Math.floor((c + 1) / CHUNK);
  // The moves that change each chunk (with a two-sample border), sorted, for exact updates.
  const lists: number[][] = Array.from({ length: count }, () => []);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const r = g.removed[(k * ny + j) * nx + i];
        if (r === KEPT) continue;
        const a0 = Math.max(0, chunkOf(i - 2));
        const a1 = Math.min(cx - 1, chunkOf(i + 1));
        const b0 = Math.max(0, chunkOf(j - 2));
        const b1 = Math.min(cy - 1, chunkOf(j + 1));
        const c0 = Math.max(0, chunkOf(k - 2));
        const c1 = Math.min(cz - 1, chunkOf(k + 1));
        for (let c = c0; c <= c1; c++) for (let b = b0; b <= b1; b++) for (let a = a0; a <= a1; a++) lists[(c * cy + b) * cx + a].push(r);
      }
  const changes = lists.map((l) => Int32Array.from(new Set(l)).sort());
  /** Does chunk id change for any move in [a, b)? */
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
  /** Is part point p inside what move m sweeps? Returns the segment index, or -1. */
  const inMove = (m: number, p: Vec): number => {
    const mv = input.moves[m];
    const s = input.setups[mv.setup];
    const tool = toolOf.get(mv.tool) ?? { radius: 3, cone: false };
    const q = toMachine(s, p);
    for (let i = 1; i < mv.points.length; i++) if (sweeps(q[0], q[1], q[2], mv.points[i - 1], mv.points[i], tool.radius, tool.cone)) return i;
    return -1;
  };

  /**
   * Where the surface crosses the edge from sample A (solid) to sample B (cut or outside), and
   * which way it faces. dir: +1 if B is the next sample along the axis, -1 if the previous.
   */
  const crossing = (A: [number, number, number], axis: number, dir: number, removedB: number | null): Cross => {
    const pa = sampleAt(A[0], A[1], A[2]);
    if (removedB === null) {
      // Outside the raw part: its face lies halfway between the samples.
      const p: Vec = [...pa];
      p[axis] += (dir * h[axis]) / 2;
      const n: Vec = [0, 0, 0];
      n[axis] = dir;
      return { p, n, cut: false };
    }
    const pb: Vec = [...pa];
    pb[axis] += dir * h[axis];
    // Binary search for the edge of the tool that cut B.
    let t0 = 0;
    let t1 = 1;
    let seg = inMove(removedB, pb);
    if (seg < 0 || inMove(removedB, pa) >= 0) {
      const p: Vec = [...pa];
      p[axis] += (dir * h[axis]) / 2;
      const n: Vec = [0, 0, 0];
      n[axis] = dir;
      return { p, n, cut: true };
    }
    const at = (t: number): Vec => [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t];
    for (let it = 0; it < 9; it++) {
      const tm = (t0 + t1) / 2;
      const sgm = inMove(removedB, at(tm));
      if (sgm >= 0) {
        t1 = tm;
        seg = sgm;
      } else t0 = tm;
    }
    const p = at((t0 + t1) / 2);
    const mv = input.moves[removedB];
    const s = input.setups[mv.setup];
    const tool = toolOf.get(mv.tool) ?? { radius: 3, cone: false };
    const nm = sweepNormal(toMachine(s, p), mv.points[seg - 1], mv.points[seg], tool.radius, tool.cone, Math.max(h[0], h[1], h[2]) * 0.75);
    return { p, n: toPart(s, nm), cut: true };
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
    build(id, stepNo) {
      const ca = id % cx;
      const cb = Math.floor(id / cx) % cy;
      const cc = Math.floor(id / (cx * cy));
      const solid = (i: number, j: number, k: number) => inGrid(i, j, k) && g.removed[(k * ny + j) * nx + i] >= stepNo;
      const removedAt = (i: number, j: number, k: number) => (inGrid(i, j, k) ? g.removed[(k * ny + j) * nx + i] : null);

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
        if (s1 && !s2) c = crossing([i, j, k], axis, 1, removedAt(i2, j2, k2));
        else if (!s1 && s2) c = crossing([i2, j2, k2], axis, -1, removedAt(i, j, k));
        edgeCache.set(key, c);
        return c;
      };

      // One vertex per cell that the surface passes through: the point that best fits the
      // planes of its crossings (sharp edges and corners), kept inside the cell.
      const vertCache = new Map<number, Vec>();
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
        const v = solveQef(cs, lo3, hi3);
        vertCache.set(key, v);
        return v;
      };

      const pos: number[] = [];
      const nor: number[] = [];
      const cut: number[] = [];
      const tri = (a: Vec, b: Vec, c: Vec, want: Vec, isCut: boolean) => {
        const ux = b[0] - a[0];
        const uy = b[1] - a[1];
        const uz = b[2] - a[2];
        const vx = c[0] - a[0];
        const vy = c[1] - a[1];
        const vz = c[2] - a[2];
        let fx = uy * vz - uz * vy;
        let fy = uz * vx - ux * vz;
        let fz = ux * vy - uy * vx;
        const len = Math.hypot(fx, fy, fz);
        if (len < 1e-12) return;
        fx /= len;
        fy /= len;
        fz /= len;
        if (fx * want[0] + fy * want[1] + fz * want[2] < 0) {
          [b, c] = [c, b];
          fx = -fx;
          fy = -fy;
          fz = -fz;
        }
        pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
        for (let q = 0; q < 3; q++) {
          nor.push(fx, fy, fz);
          cut.push(isCut ? 1 : 0);
        }
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
              const cell = (dp: number, dq: number): Vec => {
                const c: [number, number, number] = [i, j, k];
                c[p] -= dp;
                c[q] -= dq;
                return vertex(c[0], c[1], c[2]);
              };
              const v00 = cell(1, 1);
              const v10 = cell(0, 1);
              const v11 = cell(0, 0);
              const v01 = cell(1, 0);
              const want = e.n;
              tri(v00, v10, v11, want, e.cut);
              tri(v00, v11, v01, want, e.cut);
            }
          }
      return { id, positions: new Float32Array(pos), normals: new Float32Array(nor), cut: new Uint8Array(cut) };
    },
  };
}

/** Least-squares point of the crossing planes, pulled a little toward their middle, kept in the cell. */
function solveQef(cs: Cross[], lo: Vec, hi: Vec): Vec {
  if (!cs.length) return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const m: Vec = [0, 0, 0];
  for (const c of cs) for (let a = 0; a < 3; a++) m[a] += c.p[a] / cs.length;
  // Solve (AᵀA + λI) x = Aᵀb + λ m in coordinates relative to m.
  const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const B = [0, 0, 0];
  for (const c of cs) {
    const d = c.n[0] * (c.p[0] - m[0]) + c.n[1] * (c.p[1] - m[1]) + c.n[2] * (c.p[2] - m[2]);
    for (let r = 0; r < 3; r++) {
      for (let s = 0; s < 3; s++) A[r * 3 + s] += c.n[r] * c.n[s];
      B[r] += c.n[r] * d;
    }
  }
  const lam = 0.02;
  A[0] += lam;
  A[4] += lam;
  A[8] += lam;
  const det = A[0] * (A[4] * A[8] - A[5] * A[7]) - A[1] * (A[3] * A[8] - A[5] * A[6]) + A[2] * (A[3] * A[7] - A[4] * A[6]);
  let x: Vec = [0, 0, 0];
  if (Math.abs(det) > 1e-12) {
    const inv = [
      A[4] * A[8] - A[5] * A[7], A[2] * A[7] - A[1] * A[8], A[1] * A[5] - A[2] * A[4],
      A[5] * A[6] - A[3] * A[8], A[0] * A[8] - A[2] * A[6], A[2] * A[3] - A[0] * A[5],
      A[3] * A[7] - A[4] * A[6], A[1] * A[6] - A[0] * A[7], A[0] * A[4] - A[1] * A[3],
    ];
    x = [(inv[0] * B[0] + inv[1] * B[1] + inv[2] * B[2]) / det, (inv[3] * B[0] + inv[4] * B[1] + inv[5] * B[2]) / det, (inv[6] * B[0] + inv[7] * B[1] + inv[8] * B[2]) / det];
  }
  const out: Vec = [m[0] + x[0], m[1] + x[1], m[2] + x[2]];
  for (let a = 0; a < 3; a++) out[a] = Math.min(hi[a], Math.max(lo[a], out[a]));
  return out;
}
