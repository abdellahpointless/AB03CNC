import type { Move, Vec } from './toolpath';

/*
 * Where the tool is at any instant of the program, so it glides along its path instead of hopping
 * from the end of one move to the end of the next. An instant is `pos` = moves done + the share of
 * the current move's time done. The cut part (stockSim) uses the same shares, so the material
 * goes exactly where the tool is.
 */

/** Share of a drilling cycle's time spent going down to the hole bottom (the rest retracts). */
export const DRILL_DOWN = 0.8;

/** The path a move follows (a drilling cycle: down from the R plane to the hole bottom). */
export const movePath = (m: Move): Vec[] =>
  m.kind === 'drill' ? [m.points[0], [m.points[0][0], m.points[0][1], m.depth ?? m.points[0][2]]] : m.points;

/** Running length along a polyline, as shares of its whole length (0 .. 1). */
export function runShares(points: Vec[]): Float64Array {
  const out = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    out[i] = out[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  const total = out[points.length - 1];
  for (let i = 1; i < points.length; i++) out[i] = total > 1e-12 ? out[i] / total : 1;
  return out;
}

const lerp = (a: Vec, b: Vec, t: number): Vec => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** The point at share u (0..1) of a path's length, and how many of its segments are behind it. */
export function pointAlong(pts: Vec[], run: Float64Array, u: number): { p: Vec; done: number } {
  if (pts.length < 2) return { p: pts[0] ?? [0, 0, 0], done: 0 };
  let i = 1;
  while (i < pts.length - 1 && run[i] < u) i++;
  const span = run[i] - run[i - 1];
  const t = span > 1e-12 ? Math.min(1, Math.max(0, (u - run[i - 1]) / span)) : 1;
  return { p: lerp(pts[i - 1], pts[i], t), done: t >= 1 ? i : i - 1 };
}

export interface ToolAt {
  /** Tool tip. */
  p: Vec;
  /** Share of the move's path cut so far (0..1). */
  cut: number;
  /** Segments of the path completely behind the tool. */
  done: number;
}

/** Where the tool is after share f (0..1) of move m's time; `pts`/`run` from movePath/runShares. */
export function toolAlong(m: Move, pts: Vec[], run: Float64Array, f: number): ToolAt {
  const share = Math.min(1, Math.max(0, f));
  if (m.kind === 'drill' && pts.length === 2) {
    if (share <= DRILL_DOWN) {
      const cut = share / DRILL_DOWN;
      return { p: lerp(pts[0], pts[1], cut), cut, done: cut >= 1 ? 1 : 0 };
    }
    // Back up out of the hole.
    return { p: lerp(pts[1], pts[0], (share - DRILL_DOWN) / (1 - DRILL_DOWN)), cut: 1, done: 1 };
  }
  const at = pointAlong(pts, run, share);
  return { p: at.p, cut: share, done: at.done };
}

/** The tool at instant pos of a whole program (null before the first move). */
export function toolAt(moves: Move[], pos: number): (ToolAt & { move: number }) | null {
  if (!moves.length || pos <= 0) return null;
  const k = Math.min(Math.floor(pos), moves.length - 1);
  const m = moves[k];
  const pts = movePath(m);
  return { ...toolAlong(m, pts, runShares(pts), pos - k), move: k };
}

/**
 * The instant a collision happens in its move: where the tool passes over the hit point (closest in
 * X/Y; the holder's point is above the tip), or the bottom of a drilling cycle.
 */
export function hitInstant(moves: Move[], move: number, point: Vec): number {
  const m = moves[move];
  if (!m) return move;
  if (m.kind === 'drill') return move + DRILL_DOWN;
  const pts = movePath(m);
  const run = runShares(pts);
  let best = Infinity;
  let at = 1;
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 > 1e-12 ? Math.min(1, Math.max(0, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / l2)) : 1;
    const d = Math.hypot(a[0] + dx * t - point[0], a[1] + dy * t - point[1]);
    if (d < best - 1e-9) {
      best = d;
      at = run[i - 1] + (run[i] - run[i - 1]) * t;
    }
  }
  // Inside the move (its very end would already be the next move).
  return move + Math.min(at, 0.999);
}
