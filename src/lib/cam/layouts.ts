import type { Vec } from '../toolpath';
import { apply, IDENTITY, mul, type Mat3 } from '../orient';
import { SIDES, SPIN, upTurn } from './features';
import { bounds, turnTris } from './geom';
import { reachable } from './program';
import { OVERHANG, VISE } from '../setups';

/*
 * The ways the part can lie in the vise for its first setup: each side up, as is or turned a
 * quarter (X and Y swapped). Each is scored for safety and time, best first: it must fit the vise,
 * one vise is better than two, fewer setups are faster, more done from the first side is better,
 * the jaws should hold the long side, and a low, wide part sits steadier than a tall, narrow one. The operator picks one (or keeps the
 * suggestion); the planner then follows it (CamInput.orient).
 */

export interface Layout {
  side: string;
  spin: boolean;
  /** Model -> first setup frame (rotation only). */
  R: Mat3;
  /** The part in the vise: X along the jaws, Y between them, Z up (mm). */
  size: Vec;
  /** Share of what must be cut away that the top side reaches (0..1), and the setups needed (estimate). */
  topShare: number;
  setups: number;
  /** Too long for one vise (X): both vises; does not fit at all. */
  twoVises: boolean;
  fits: boolean;
  /** Lower is better. */
  score: number;
}

export function layouts(tris: ArrayLike<number>): Layout[] {
  const b = bounds(tris);
  const size = [0, 1, 2].map((k) => b.max[k] - b.min[k]) as Vec;
  const centred = turnTris(tris, IDENTITY, [0, 1, 2].map((k) => -(b.min[k] + b.max[k]) / 2) as Vec);
  // What must be cut away: the box around the part (1 mm over) minus the part.
  const { occ, reach } = reachable(centred, size.map((v) => -v / 2 - 1) as Vec, size.map((v) => v / 2 + 1) as Vec);
  let total = 0;
  for (let i = 0; i < occ.length; i++) if (!occ[i]) total++;
  const out: Layout[] = [];
  SIDES.forEach((side, si) => {
    const opposite = SIDES.findIndex((s) => s.d.every((v, k) => v === -side.d[k]));
    // The setups: this side, its opposite, then whichever side reaches most of the rest.
    const covered = new Uint8Array(occ.length);
    const take = (k: number) => {
      for (let i = 0; i < occ.length; i++) if (reach[k][i]) covered[i] = 1;
    };
    let top = 0;
    for (let i = 0; i < occ.length; i++) if (!occ[i] && reach[si][i]) top++;
    take(si);
    take(opposite);
    let setups = 2;
    for (;;) {
      let best = -1;
      let gain = 0;
      for (let k = 0; k < 6; k++) {
        let g = 0;
        for (let i = 0; i < occ.length; i++) if (!occ[i] && !covered[i] && reach[k][i]) g++;
        if (g > gain) [best, gain] = [k, g];
      }
      if (best < 0 || gain < total * 0.001) break;
      take(best);
      setups++;
    }
    for (const spin of [false, true]) {
      const R = spin ? mul(SPIN, upTurn(side.d)) : upTurn(side.d);
      const s = apply(R, size).map(Math.abs) as Vec;
      const twoVises = s[0] > VISE.width + OVERHANG;
      const fits = s[1] <= VISE.opening && s[0] <= VISE.width * 2 + VISE.gap;
      const topShare = total ? top / total : 1;
      // The jaws hold a part best by its long faces (as later setups are turned, program.ts).
      const across = s[0] < s[1] - 0.5 && s[1] <= VISE.width + OVERHANG;
      const score = (fits ? 0 : 1000) + setups * 10 + (twoVises ? 4 : 0) + (across ? 5 : 0) + (s[2] / Math.min(s[0], s[1])) * 3 - topShare * 6;
      out.push({ side: side.name, spin, R, size: s, topShare, setups, twoVises, fits, score });
    }
  });
  return out.sort((a, c) => a.score - c.score);
}

/** Excess given in the vise's X, Y, Z, back to the model's axes (for CamInput.raw). */
export const toModelAxes = (R: Mat3, v: Vec): Vec => [0, 1, 2].map((k) => v[[0, 1, 2].find((j) => R[j * 3 + k] !== 0)!]) as Vec;
/** A size along the model's axes as the vise holds it (R: model -> clamping), as the Stock panel and the G-code give it. */
export const toViseAxes = (R: readonly number[], v: readonly number[]): Vec => [0, 1, 2].map((j) => [0, 1, 2].reduce((a, k) => a + Math.abs(R[j * 3 + k]) * v[k], 0)) as Vec;
/** Stock on each side of clamping 1 (lo: its X-, Y-, Z-; hi: X+, Y+, Z+) as the model's sides (R: model -> clamping 1). */
export const toModelSides = (R: Mat3, lo: Vec, hi: Vec): { lo: Vec; hi: Vec } => {
  const j = [0, 1, 2].map((k) => [0, 1, 2].find((i) => R[i * 3 + k] !== 0)!);
  const up = [0, 1, 2].map((k) => R[j[k] * 3 + k] > 0);
  return { lo: [0, 1, 2].map((k) => (up[k] ? lo : hi)[j[k]]) as Vec, hi: [0, 1, 2].map((k) => (up[k] ? hi : lo)[j[k]]) as Vec };
};
