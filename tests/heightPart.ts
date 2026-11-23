// Test parts built from heights on a grid (closed meshes, 2.5D), or a plate with round holes.
import { ShapeUtils, Vector2 } from 'three';

/** A 2.5D part from heights on a 1 mm grid (cell i, j is h[j][i] tall): its closed mesh. */
export function heightPart(h: number[][]): Float32Array {
  const ny = h.length;
  const nx = h[0].length;
  const at = (i: number, j: number) => (i < 0 || j < 0 || i >= nx || j >= ny ? 0 : h[j][i]);
  const t: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => t.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const z = at(i, j);
      quad([i, j, z], [i + 1, j, z], [i + 1, j + 1, z], [i, j + 1, z]);
      quad([i, j, 0], [i, j + 1, 0], [i + 1, j + 1, 0], [i + 1, j, 0]);
      // Walls down to each lower neighbour (or the floor at the edge), facing it.
      const e = at(i + 1, j);
      if (e < z) quad([i + 1, j, e], [i + 1, j + 1, e], [i + 1, j + 1, z], [i + 1, j, z]);
      const w = at(i - 1, j);
      if (w < z) quad([i, j, w], [i, j, z], [i, j + 1, z], [i, j + 1, w]);
      const n = at(i, j + 1);
      if (n < z) quad([i, j + 1, n], [i, j + 1, z], [i + 1, j + 1, z], [i + 1, j + 1, n]);
      const s = at(i, j - 1);
      if (s < z) quad([i, j, s], [i + 1, j, s], [i + 1, j, z], [i, j, z]);
    }
  return new Float32Array(t);
}

/**
 * A part from columns on a 1 mm grid: cell i, j is solid from lo[j][i] up to hi[j][i] (empty where they
 * are equal), so a hole can also open downwards: its closed mesh.
 */
export function columnPart(lo: number[][], hi: number[][]): Float32Array {
  const ny = hi.length;
  const nx = hi[0].length;
  const col = (i: number, j: number): [number, number] => (i < 0 || j < 0 || i >= nx || j >= ny ? [0, 0] : [lo[j][i], hi[j][i]]);
  const t: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => t.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const [f, z] = col(i, j);
      if (z <= f) continue;
      quad([i, j, z], [i + 1, j, z], [i + 1, j + 1, z], [i, j + 1, z]);
      quad([i, j, f], [i, j + 1, f], [i + 1, j + 1, f], [i + 1, j, f]);
      // A wall facing each neighbour where it has no material: below its column and above it.
      const open = ([n0, n1]: [number, number]) => (n1 <= n0 ? [[f, z]] : [[f, Math.min(z, n0)], [Math.max(f, n1), z]]).filter(([a, b]) => b > a);
      for (const [a, b] of open(col(i + 1, j))) quad([i + 1, j, a], [i + 1, j + 1, a], [i + 1, j + 1, b], [i + 1, j, b]);
      for (const [a, b] of open(col(i - 1, j))) quad([i, j, a], [i, j, b], [i, j + 1, b], [i, j + 1, a]);
      for (const [a, b] of open(col(i, j + 1))) quad([i, j + 1, a], [i, j + 1, b], [i + 1, j + 1, b], [i + 1, j + 1, a]);
      for (const [a, b] of open(col(i, j - 1))) quad([i, j, a], [i + 1, j, a], [i + 1, j, b], [i, j, b]);
    }
  return new Float32Array(t);
}

/**
 * A W x L x H plate (corner at the origin) with a rectangular pocket [x0, y0, x1, y1] `depth` deep in
 * its top and one round hole through the pocket's floor: its closed mesh (48-sided hole).
 */
export function pocketWithHole(W: number, L: number, H: number, pocket: [number, number, number, number], depth: number, hole: { c: [number, number]; d: number }): Float32Array {
  const N = 48;
  const floorZ = H - depth;
  const ring = Array.from({ length: N }, (_, k) => [hole.c[0] + (hole.d / 2) * Math.cos((2 * Math.PI * k) / N), hole.c[1] + (hole.d / 2) * Math.sin((2 * Math.PI * k) / N)] as [number, number]);
  const [x0, y0, x1, y1] = pocket;
  const outer: [number, number][] = [[0, 0], [W, 0], [W, L], [0, L]];
  const inner: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const t: number[] = [];
  const tri = (a: number[], b: number[], c: number[], n: number[]) => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const x = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    t.push(...(x[0] * n[0] + x[1] * n[1] + x[2] * n[2] >= 0 ? [...a, ...b, ...c] : [...a, ...c, ...b]));
  };
  const face = (contour: [number, number][], holes: [number, number][][], z: number, nz: number) => {
    const all = [...contour, ...holes.flat()];
    for (const [i, j, k] of ShapeUtils.triangulateShape(contour.map(([x, y]) => new Vector2(x, y)), holes.map((h) => h.map(([x, y]) => new Vector2(x, y)))))
      tri([...all[i], z], [...all[j], z], [...all[k], z], [0, 0, nz]);
  };
  const wall = (a: [number, number], b: [number, number], za: number, zb: number, n: number[]) => {
    tri([...a, za], [...b, za], [...b, zb], n);
    tri([...a, za], [...b, zb], [...a, zb], n);
  };
  face(outer, [inner], H, 1);
  face(inner, [ring], floorZ, 1);
  face(outer, [ring], 0, -1);
  wall([0, 0], [W, 0], 0, H, [0, -1, 0]);
  wall([W, 0], [W, L], 0, H, [1, 0, 0]);
  wall([W, L], [0, L], 0, H, [0, 1, 0]);
  wall([0, L], [0, 0], 0, H, [-1, 0, 0]);
  // The pocket's walls face into the pocket.
  wall([x0, y0], [x1, y0], floorZ, H, [0, 1, 0]);
  wall([x1, y0], [x1, y1], floorZ, H, [-1, 0, 0]);
  wall([x1, y1], [x0, y1], floorZ, H, [0, -1, 0]);
  wall([x0, y1], [x0, y0], floorZ, H, [1, 0, 0]);
  ring.forEach((p, k) => {
    const q = ring[(k + 1) % N];
    const m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    wall(p, q, 0, floorZ, [hole.c[0] - m[0], hole.c[1] - m[1], 0]);
  });
  return new Float32Array(t);
}

/** A W x L x H plate (corner at the origin) with round holes straight through it: its closed mesh (48-sided holes). */
export function plateWithHoles(W: number, L: number, H: number, holes: { c: [number, number]; d: number }[]): Float32Array {
  const N = 48;
  const rings = holes.map(({ c, d }) => Array.from({ length: N }, (_, k) => [c[0] + (d / 2) * Math.cos((2 * Math.PI * k) / N), c[1] + (d / 2) * Math.sin((2 * Math.PI * k) / N)] as [number, number]));
  const t: number[] = [];
  const tri = (a: number[], b: number[], c: number[], n: number[]) => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const x = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    t.push(...(x[0] * n[0] + x[1] * n[1] + x[2] * n[2] >= 0 ? [...a, ...b, ...c] : [...a, ...c, ...b]));
  };
  const outer: [number, number][] = [[0, 0], [W, 0], [W, L], [0, L]];
  const all = [...outer, ...rings.flat()];
  for (const [i, j, k] of ShapeUtils.triangulateShape(outer.map(([x, y]) => new Vector2(x, y)), rings.map((r) => r.map(([x, y]) => new Vector2(x, y)))))
    for (const [z, nz] of [[H, 1], [0, -1]]) tri([...all[i], z], [...all[j], z], [...all[k], z], [0, 0, nz]);
  const wall = (a: [number, number], b: [number, number], n: number[]) => {
    tri([...a, 0], [...b, 0], [...b, H], n);
    tri([...a, 0], [...b, H], [...a, H], n);
  };
  wall([0, 0], [W, 0], [0, -1, 0]);
  wall([W, 0], [W, L], [1, 0, 0]);
  wall([W, L], [0, L], [0, 1, 0]);
  wall([0, L], [0, 0], [-1, 0, 0]);
  rings.forEach((r, h) =>
    r.forEach((p, k) => {
      const q = r[(k + 1) % N];
      const m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      wall(p, q, [holes[h].c[0] - m[0], holes[h].c[1] - m[1], 0]);
    }),
  );
  return new Float32Array(t);
}


/** The walls (near-vertical triangles, by index in `tris`) whose middle `near` takes: what an operator picks to finish. */
export function wallsOf(tris: ArrayLike<number>, near: (x: number, y: number) => boolean = () => true): number[] {
  const out: number[] = [];
  for (let k = 0; k * 9 + 8 < tris.length; k++) {
    const t = Array.from({ length: 9 }, (_, i) => tris[k * 9 + i]);
    const [u, v] = [[t[3] - t[0], t[4] - t[1], t[5] - t[2]], [t[6] - t[0], t[7] - t[1], t[8] - t[2]]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (!len || Math.abs(n[2]) / len > 0.3) continue;
    if (near((t[0] + t[3] + t[6]) / 3, (t[1] + t[4] + t[7]) / 3)) out.push(k);
  }
  return out;
}

/**
 * A W x L x H plate (corner at the origin) with one blind round hole from its top, `depth` deep to where its wall
 * ends, its bottom a drill point (118°, as CAD draws a drilled hole) or flat: its closed mesh (48-sided hole).
 */
export function plateWithBlindHole(W: number, L: number, H: number, hole: { c: [number, number]; d: number; depth: number; point: boolean }): Float32Array {
  const N = 48;
  const { c, d, depth } = hole;
  const ring = Array.from({ length: N }, (_, k) => [c[0] + (d / 2) * Math.cos((2 * Math.PI * k) / N), c[1] + (d / 2) * Math.sin((2 * Math.PI * k) / N)] as [number, number]);
  const t: number[] = [];
  const tri = (a: number[], b: number[], e: number[], n: number[]) => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [e[0] - a[0], e[1] - a[1], e[2] - a[2]];
    const x = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    t.push(...(x[0] * n[0] + x[1] * n[1] + x[2] * n[2] >= 0 ? [...a, ...b, ...e] : [...a, ...e, ...b]));
  };
  const outer: [number, number][] = [[0, 0], [W, 0], [W, L], [0, L]];
  const top = [...outer, ...ring];
  for (const [i, j, k] of ShapeUtils.triangulateShape(outer.map(([x, y]) => new Vector2(x, y)), [ring.map(([x, y]) => new Vector2(x, y))])) tri([...top[i], H], [...top[j], H], [...top[k], H], [0, 0, 1]);
  tri([0, 0, 0], [W, 0, 0], [W, L, 0], [0, 0, -1]);
  tri([0, 0, 0], [W, L, 0], [0, L, 0], [0, 0, -1]);
  const wall = (a: [number, number], b: [number, number], z0: number, z1: number, n: number[]) => {
    tri([...a, z0], [...b, z0], [...b, z1], n);
    tri([...a, z0], [...b, z1], [...a, z1], n);
  };
  wall([0, 0], [W, 0], 0, H, [0, -1, 0]);
  wall([W, 0], [W, L], 0, H, [1, 0, 0]);
  wall([W, L], [0, L], 0, H, [0, 1, 0]);
  wall([0, L], [0, 0], 0, H, [-1, 0, 0]);
  const zb = H - depth;
  // The tip 0.3 x Ø under the end of the wall (118°).
  const tip = [c[0], c[1], hole.point ? zb - 0.3 * d : zb];
  ring.forEach((p, k) => {
    const q = ring[(k + 1) % N];
    const m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    wall(p, q, zb, H, [c[0] - m[0], c[1] - m[1], 0]);
    tri([...p, zb], [...q, zb], tip, [c[0] - m[0], c[1] - m[1], hole.point ? 1 : 0].map((v, i) => (hole.point ? v : i === 2 ? 1 : 0)));
  });
  return new Float32Array(t);
}
