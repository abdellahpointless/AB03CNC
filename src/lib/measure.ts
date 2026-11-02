import type { Vec } from './toolpath';

/*
 * Measuring on the simulated part (part frame, mm): the distance between two picked points, and the
 * diameter of a hole or a round boss from three points picked on its wall.
 */

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec) => Math.hypot(a[0], a[1], a[2]);

export const distance = (a: Vec, b: Vec) => len(sub(b, a));

/**
 * The circle through three points on a round wall: its centre, axis and diameter. The wall's
 * normals give the axis (a cylinder's normals are all square to it), so the points may lie at
 * different depths; on a flat face (normals all alike) the circle through the points themselves.
 * Null when the points are in a line.
 */
export function circleOf(p: [Vec, Vec, Vec], n: [Vec, Vec, Vec]): { centre: Vec; axis: Vec; diameter: number } | null {
  const pairs = [cross(n[0], n[1]), cross(n[1], n[2]), cross(n[0], n[2])];
  let axis = pairs.reduce((a, b) => (len(b) > len(a) ? b : a));
  if (len(axis) < 0.2) axis = cross(sub(p[1], p[0]), sub(p[2], p[0]));
  const l = len(axis);
  if (l < 1e-9) return null;
  axis = [axis[0] / l, axis[1] / l, axis[2] / l];
  // Onto the plane square to the axis through the first point.
  const flat = p.map((q) => {
    const d = dot(sub(q, p[0]), axis);
    return [q[0] - axis[0] * d, q[1] - axis[1] * d, q[2] - axis[2] * d] as Vec;
  });
  const a = sub(flat[1], flat[0]);
  const b = sub(flat[2], flat[0]);
  const axb = cross(a, b);
  const d = 2 * dot(axb, axb);
  if (d < 1e-12) return null;
  // Circumcentre of the triangle (flat[0] + ...).
  const t1 = cross(axb, a);
  const t2 = cross(b, axb);
  const aa = dot(a, a);
  const bb = dot(b, b);
  const off: Vec = [(t2[0] * aa + t1[0] * bb) / d, (t2[1] * aa + t1[1] * bb) / d, (t2[2] * aa + t1[2] * bb) / d];
  const centre: Vec = [flat[0][0] + off[0], flat[0][1] + off[1], flat[0][2] + off[2]];
  return { centre, axis, diameter: 2 * len(off) };
}
