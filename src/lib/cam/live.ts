// What the CAM AI page shows while the planner works (cam.worker 'live' events), always moving forward.
import type { LivePath } from '../../components/CamPartView';
import type { LiveEvent } from './program';

/**
 * The pass shown: its steps, setups and paths. `pct` only grows. When the planner starts over (another
 * axis, the blank centred, a POM nest), that pass runs hidden in `next` while the one before stays on
 * screen; it is shown once it has finished (checked), with the paths of the last pass; one dropped
 * after it began never is. tries: the passes begun.
 */
export type Live = { stages: string[]; setup: number; of: number; sides: string[]; paths: (LivePath & { setup: number })[]; pct: number; base: number; next: Live | null; tries: number };
export const NO_LIVE: Live = { stages: [], setup: -1, of: 0, sides: [], paths: [], pct: 0, base: 0, next: null, tries: 0 };

/** One pass's own step, not counting a hidden one. */
function step(l: Live, e: LiveEvent): Live {
  if (e.kind === 'reset') return NO_LIVE;
  if (e.kind === 'path') return { ...l, paths: [...l.paths, { setup: e.setup, purpose: e.purpose, pts: e.pts, key: e.key, tool: e.tool }] };
  const sides = [...l.sides];
  if (e.stage === 'setup' && e.setup !== undefined && e.side) sides[e.setup] = e.side;
  return { ...l, stages: [...l.stages, e.stage], setup: e.stage === 'setup' ? (e.setup ?? l.setup) : l.setup, of: Math.max(l.of, e.of ?? 0), sides };
}

/** How far along a pass is (0 to 1): features, stock, each setup, check, post. */
const share = (l: Live) => Math.min(1, l.stages.length / (4 + Math.max(l.of, 1)));

export function liveStep(l: Live, e: LiveEvent): Live {
  // The first pass starts as new; once one is on screen, every new pass runs hidden behind it.
  if (e.kind === 'reset') return l.stages.length ? { ...l, base: l.pct, next: NO_LIVE, tries: l.tries + 1 } : { ...NO_LIVE, pct: l.pct, base: l.base, tries: l.tries + 1 };
  const now = step(l.next ?? l, e);
  // Each pass fills 85 % of what is left: the bar never goes back and stays under 100 until the end (rounded, it
  // reached 100 on the third pass and sat there while more ran).
  const pct = Math.min(99, Math.max(l.pct, Math.round(l.base + (100 - l.base) * 0.85 * share(now))));
  if (!l.next) return { ...now, pct, base: l.base, next: null, tries: l.tries };
  // A hidden pass that has finished is shown, with its paths; one dropped after it began (no check) is not.
  if (e.kind === 'stage' && e.stage === 'post') return now.stages.includes('check') ? { ...now, pct, base: l.base, next: null, tries: l.tries } : { ...l, pct, next: null };
  return { ...l, pct, next: now };
}
