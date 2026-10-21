import type { Toolpath, Vec } from './toolpath';
import type { Mat3 } from './orient';
import type { ProgramSetups } from './setups';

/*
 * The part as a solid block of small cubes (voxels) in its own frame. Every cutting move takes
 * away the cubes the tool passes through; each cube remembers which move took it away, so the
 * part can be shown at any point of the program without cutting again.
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
  /** Upper limit of cubes (memory and time). */
  maxVoxels?: number;
}

export interface Grid {
  n: [number, number, number];
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

export function carve(input: SimInput, onProgress?: (share: number) => void): Grid {
  const { part } = input;
  const ext: Vec = [part.max[0] - part.min[0], part.max[1] - part.min[1], part.max[2] - part.min[2]];
  const maxVoxels = input.maxVoxels ?? 1_500_000;
  const size = Math.max(0.15, Math.cbrt((ext[0] * ext[1] * ext[2]) / maxVoxels));
  const n: [number, number, number] = [Math.max(1, Math.ceil(ext[0] / size)), Math.max(1, Math.ceil(ext[1] / size)), Math.max(1, Math.ceil(ext[2] / size))];
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
    // Machine Z of the part's top in this setup: nothing above it to cut.
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
        // part = Rᵀ · d
        const p: Vec = [R[0] * d[0] + R[3] * d[1] + R[6] * d[2], R[1] * d[0] + R[4] * d[1] + R[7] * d[2], R[2] * d[0] + R[5] * d[1] + R[8] * d[2]];
        for (let k = 0; k < 3; k++) {
          pl[k] = Math.min(pl[k], p[k]);
          ph[k] = Math.max(ph[k], p[k]);
        }
      }
      const i0 = Math.max(0, Math.floor((pl[0] - origin[0]) / size));
      const i1 = Math.min(nx - 1, Math.floor((ph[0] - origin[0]) / size));
      const j0 = Math.max(0, Math.floor((pl[1] - origin[1]) / size));
      const j1 = Math.min(ny - 1, Math.floor((ph[1] - origin[1]) / size));
      const k0 = Math.max(0, Math.floor((pl[2] - origin[2]) / size));
      const k1 = Math.min(nz - 1, Math.floor((ph[2] - origin[2]) / size));
      if (i0 > i1 || j0 > j1 || k0 > k1) continue;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const dz = b[2] - a[2];
      const l2 = dx * dx + dy * dy;
      const r2 = r * r;
      for (let k = k0; k <= k1; k++) {
        const pz = origin[2] + (k + 0.5) * size;
        for (let j = j0; j <= j1; j++) {
          const py = origin[1] + (j + 0.5) * size;
          let v = (k * ny + j) * nx + i0;
          for (let i = i0; i <= i1; i++, v++) {
            if (removed[v] !== KEPT) continue;
            const px = origin[0] + (i + 0.5) * size;
            const mx = R[0] * px + R[1] * py + R[2] * pz + t[0];
            const my = R[3] * px + R[4] * py + R[5] * pz + t[1];
            const mz = R[6] * px + R[7] * py + R[8] * pz + t[2];
            let u = l2 > 0 ? ((mx - a[0]) * dx + (my - a[1]) * dy) / l2 : 0;
            u = u < 0 ? 0 : u > 1 ? 1 : u;
            const tip = a[2] + u * dz;
            const above = mz - tip;
            if (above < -1e-6) continue;
            const ex = mx - (a[0] + u * dx);
            const ey = my - (a[1] + u * dy);
            const d2 = ex * ex + ey * ey;
            if (tool.cone) {
              const rr = Math.min(r, above);
              if (d2 <= rr * rr) removed[v] = index;
            } else if (d2 <= r2) removed[v] = index;
          }
        }
      }
    }
  });
  onProgress?.(1);
  return { n, size, origin, removed };
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

// Face of a cube: normal, then its four corners (unit cube).
const FACES: { n: Vec; c: Vec[] }[] = [
  { n: [1, 0, 0], c: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  { n: [-1, 0, 0], c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
  { n: [0, 1, 0], c: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
  { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { n: [0, 0, -1], c: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
];

export function mesher(g: Grid): Mesher {
  const [nx, ny, nz] = g.n;
  const cx = Math.ceil(nx / CHUNK);
  const cy = Math.ceil(ny / CHUNK);
  const cz = Math.ceil(nz / CHUNK);
  const count = cx * cy * cz;
  // Earliest and latest move that changes each chunk (with a one-cube border).
  const lo = new Int32Array(count).fill(KEPT);
  const hi = new Int32Array(count).fill(-1);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const r = g.removed[(k * ny + j) * nx + i];
        if (r === KEPT) continue;
        for (let dk = -1; dk <= 1; dk++)
          for (let dj = -1; dj <= 1; dj++)
            for (let di = -1; di <= 1; di++) {
              if ((di !== 0 ? 1 : 0) + (dj !== 0 ? 1 : 0) + (dk !== 0 ? 1 : 0) > 1) continue;
              const a = Math.floor((i + di) / CHUNK);
              const b = Math.floor((j + dj) / CHUNK);
              const c = Math.floor((k + dk) / CHUNK);
              if (a < 0 || b < 0 || c < 0 || a >= cx || b >= cy || c >= cz) continue;
              const id = (c * cy + b) * cx + a;
              if (r < lo[id]) lo[id] = r;
              if (r > hi[id]) hi[id] = r;
            }
      }
  const solid = (i: number, j: number, k: number, step: number) =>
    i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz && g.removed[(k * ny + j) * nx + i] >= step;
  return {
    chunks: count,
    dirty(from, to) {
      const a = Math.min(from, to);
      const b = Math.max(from, to);
      const out: number[] = [];
      for (let id = 0; id < count; id++) if (hi[id] >= a && lo[id] < b) out.push(id);
      return out;
    },
    build(id, step) {
      const a = id % cx;
      const b = Math.floor(id / cx) % cy;
      const c = Math.floor(id / (cx * cy));
      const pos: number[] = [];
      const nor: number[] = [];
      const cut: number[] = [];
      const s = g.size;
      for (let k = c * CHUNK; k < Math.min(nz, (c + 1) * CHUNK); k++)
        for (let j = b * CHUNK; j < Math.min(ny, (b + 1) * CHUNK); j++)
          for (let i = a * CHUNK; i < Math.min(nx, (a + 1) * CHUNK); i++) {
            if (!solid(i, j, k, step)) continue;
            for (const f of FACES) {
              const ni = i + f.n[0];
              const nj = j + f.n[1];
              const nk = k + f.n[2];
              if (solid(ni, nj, nk, step)) continue;
              const outside = ni < 0 || nj < 0 || nk < 0 || ni >= nx || nj >= ny || nk >= nz;
              const q = f.c.map((p) => [g.origin[0] + (i + p[0]) * s, g.origin[1] + (j + p[1]) * s, g.origin[2] + (k + p[2]) * s]);
              for (const t of [0, 1, 2, 0, 2, 3]) {
                pos.push(q[t][0], q[t][1], q[t][2]);
                nor.push(f.n[0], f.n[1], f.n[2]);
                cut.push(outside ? 0 : 1);
              }
            }
          }
      return { id, positions: new Float32Array(pos), normals: new Float32Array(nor), cut: new Uint8Array(cut) };
    },
  };
}
