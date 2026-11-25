/*
 * The numbers of clamping 1 that the page and the planner share (pure, no geometry): the blank over the part,
 * the parallels the jaws can hold it on, and the ones the planner picks. One source, so the page shows what is planned.
 */
import { CALE_HEIGHTS } from '../cales';

/** The vise's jaws over its bed (mm): the grip is JAW - parallels. */
export const JAW = 45;

/** Stock over the part's top in clamping 1 (Auto and totals), for `extra` mm of Z stock in all. */
export const blankTop = (extra: number) => (extra >= 4.5 ? Math.max(0.5, Math.min(2, extra - 4)) : Math.max(0, Math.min(2, extra / 2)));

/**
 * The blank side by side in clamping 1's frame (X-, X+, Y-, Y+, Z-, Z+) for Auto and totals, as the planner puts it:
 * X and Y centred, blankTop over the top and the rest under; flush with a top plate's white face (`white`, 0..5).
 */
export function blankSides(excess: number[], white = -1): number[] {
  const top = blankTop(excess[2]);
  const v = [excess[0] / 2, excess[0] / 2, excess[1] / 2, excess[1] / 2, excess[2] - top, top];
  if (white >= 0) {
    v[white] = 0;
    v[white ^ 1] = excess[white >> 1];
  }
  return v;
}

/**
 * The parallels the jaws hold the part on (0: none, the part on the table they stand on): 3 mm grip at least, never all of
 * the stock, jaw tops 0.5 mm under its top.
 */
export const allowedCales = (stockH: number, lo: number): number[] => [...CALE_HEIGHTS, 0].filter((c) => JAW - c >= 3 && JAW - c <= stockH - 1 && JAW - c <= -0.5 - lo);

/**
 * The cale under the part for the grip wanted (the outside is cut down to 0.5 mm above the jaws):
 * at least 3 mm to hold it, never all of the part.
 */
export function caleFor(height: number, want: number, least = 3): { cale: number; grip: number } {
  const target = Math.max(3, least, Math.min(want, height - 1));
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

/**
 * Clamping 1's grip (lo: the stock's bottom, H: the part's height, Z0 its top). You: the outline is cut whole in the
 * first clamping, 0.5 mm under the part, so after the turn only the face is cut (two outlines never meet exactly). The
 * jaws 1 mm under that (the tools keep 0.5 mm over them), as deep as the stock under the part allows: 4 mm or more of
 * it. Less: as before, the next clamping cuts the rest.
 */
export function firstWant(lo: number, H: number): number {
  const waste = -H - lo;
  return waste >= 4 ? waste - 1 : waste > 0.5 ? Math.min(5, -lo - 5) : waste - 0.5;
}

/**
 * The first clamping's outside goes 0.5 mm under the part, or stops 0.5 mm or more above its bottom for the
 * next clamping to cut from its side: never in between, where the wall would meet the face cut after the turn
 * with no overlap (a review finding).
 */
export const clearOf = (lo: number, H: number, grip: number) => lo + grip + 0.5 <= -H - 0.5 + 1e-6 || lo + grip + 0.5 >= -H + 0.5 - 1e-6;

/** CAM AI's own parallels for clamping 1 (stockH: the blank's height there): the nearest grip that is clear of the seam, the smaller first. */
export function firstPick(stockH: number, lo: number, H: number): { cale: number; grip: number } {
  const pick = caleFor(stockH, firstWant(lo, H), 3);
  if (-H - lo <= 0.5 || clearOf(lo, H, pick.grip)) return pick;
  return (
    CALE_HEIGHTS.map((c) => ({ cale: c as number, grip: JAW - c }))
      .filter((p) => p.grip >= 3 && p.grip <= stockH - 1 && p.grip <= -0.5 - lo && clearOf(lo, H, p.grip))
      .sort((p, q) => Math.abs(p.grip - pick.grip) - Math.abs(q.grip - pick.grip) || p.grip - q.grip)[0] ?? pick
  );
}

/** The parallels a step up (taller: the part higher) or down gives, from none (0) through every one the shop has; null: no further that way. */
export function stepCale(now: number | null, dir: 1 | -1): number | null {
  if (now === null) return null;
  const steps = [0, ...[...CALE_HEIGHTS].sort((p, q) => p - q)];
  const j = steps.indexOf(now) + dir;
  return steps.indexOf(now) >= 0 && j >= 0 && j < steps.length ? steps[j] : null;
}

/** Why parallels cannot hold the part (allowedCales' three rules), or null when they can. */
export function whyNot(cale: number, stockH: number, lo: number): 'tooShallow' | 'allStock' | 'overTop' | null {
  const grip = JAW - cale;
  return grip < 3 ? 'tooShallow' : grip > stockH - 1 ? 'allStock' : grip > -0.5 - lo ? 'overTop' : null;
}

/** How far the moving jaw opens (mm), the most. */
export const JAW_OPEN = 35;

/**
 * The view's vise after a move (view only: the program holds the part closed, against the fixed jaw): the moving jaw
 * `open` mm off, the part slid `slide` mm toward the operator (0 to -open). Closing pushes the part back; null: refused
 * (the part into a jaw, the jaw past its travel or already shut).
 */
export function jawMove(s: { open: number; slide: number }, act: 'back' | 'forward' | 'open' | 'close'): { open: number; slide: number } | null {
  const { open, slide } = s;
  if (act === 'back') return slide + 1 <= 0 ? { open, slide: slide + 1 } : null;
  if (act === 'forward') return slide - 1 >= -open ? { open, slide: slide - 1 } : null;
  if (act === 'open') return open + 2 <= JAW_OPEN ? { open: open + 2, slide } : null;
  if (open === 0) return null;
  const o = Math.max(0, open - 2);
  return { open: o, slide: o ? Math.max(slide, -o) : 0 };
}
