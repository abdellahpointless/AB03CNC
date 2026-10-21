import type { Vec } from './toolpath';

/*
 * Quarter-turn orientations of a part on the machine table: 3×3 integer matrices (row-major)
 * that take a direction on the part to a direction on the machine. There are 24 of them.
 */

export type Mat3 = [number, number, number, number, number, number, number, number, number];
export type Axis = 'X' | 'Y' | 'Z';

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mul(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9).fill(0) as Mat3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}

export const transpose = (a: Mat3): Mat3 => [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];

export const apply = (a: Mat3, v: Vec): Vec => [
  a[0] * v[0] + a[1] * v[1] + a[2] * v[2],
  a[3] * v[0] + a[4] * v[1] + a[5] * v[2],
  a[6] * v[0] + a[7] * v[1] + a[8] * v[2],
];

/** Right-hand rotation around a machine axis by a multiple of 90°. */
export function rotation(axis: Axis, deg: number): Mat3 {
  const q = ((Math.round(deg / 90) % 4) + 4) % 4;
  const c = [1, 0, -1, 0][q];
  const s = [0, 1, 0, -1][q];
  if (axis === 'X') return [1, 0, 0, 0, c, -s, 0, s, c];
  if (axis === 'Y') return [c, 0, s, 0, 1, 0, -s, 0, c];
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/** All 24 orientations. */
export const ALL: Mat3[] = (() => {
  const out: Mat3[] = [];
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (const p of perms)
    for (let signs = 0; signs < 8; signs++) {
      const m = new Array(9).fill(0) as Mat3;
      for (let r = 0; r < 3; r++) m[r * 3 + p[r]] = signs & (1 << r) ? -1 : 1;
      const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
      if (det === 1) out.push(m);
    }
  return out;
})();

export const same = (a: Vec, b: Vec) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** "X+" -> [1,0,0]; several faces add up ("X+ Y-" -> [1,-1,0]). */
export function direction(faces: string[]): Vec {
  const v: Vec = [0, 0, 0];
  for (const f of faces) v['XYZ'.indexOf(f[0])] += f[1] === '-' ? -1 : 1;
  return v;
}

/** How far an orientation is from another: 0 = same, larger = bigger turn. */
export const turnSize = (a: Mat3, b: Mat3) => 3 - (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] + a[4] * b[4] + a[5] * b[5] + a[6] * b[6] + a[7] * b[7] + a[8] * b[8]);

/** Size of a part-frame box once it is turned onto the machine. */
export function turnedBox(m: Mat3, min: Vec, max: Vec): { min: Vec; max: Vec } {
  const a = apply(m, min);
  const b = apply(m, max);
  return { min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])], max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])] };
}
