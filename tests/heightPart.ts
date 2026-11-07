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

