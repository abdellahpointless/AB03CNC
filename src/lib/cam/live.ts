// What the CAM AI page shows while the planner works (cam.worker 'live' events), always moving forward.
import type { LivePath } from '../../components/CamPartView';
import type { LiveEvent } from './program';

/**
 * The pass shown: its steps, setups and paths. `pct` only grows. When the planner starts over (another
 * axis, the blank centred, a POM nest), that pass runs hidden in `next` while the one before stays on
 * screen; it is shown once it has finished, with the paths of the last pass.
 */
export type Live = { stages: string[]; setup: number; of: number; sides: string[]; paths: (LivePath & { setup: number })[]; pct: number; base: number; next: Live | null };
export const NO_LIVE: Live = { stages: [], setup: -1, of: 0, sides: [], paths: [], pct: 0, base: 0, next: null };

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
  const pass = l.next ?? l;
  if (e.kind === 'reset') {
    // The first pass, or one that had not got anywhere: start as new. Else the new pass runs hidden.
    if (!pass.stages.length) return { ...NO_LIVE, pct: l.pct, base: l.base, next: l.next && NO_LIVE };
    return { ...l, base: l.pct, next: NO_LIVE };
  }
  const now = step(pass, e);
  // Each pass fills 85 % of what is left: the bar never goes back and stays under 100 until the end.
  const pct = Math.max(l.pct, Math.round(l.base + (100 - l.base) * 0.85 * share(now)));
  if (!l.next) return { ...now, pct, base: l.base, next: null };
  // A hidden pass that has finished is shown, with its paths.
  if (e.kind === 'stage' && e.stage === 'post') return { ...now, pct, base: l.base, next: null };
  return { ...l, pct, next: now };
}
