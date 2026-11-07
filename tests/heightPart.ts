// Test parts built from heights on a grid (closed meshes, 2.5D).

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
