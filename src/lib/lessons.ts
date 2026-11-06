import type { Toolpath } from './toolpath';
import type { ProgramSetups } from './setups';
import type { Mat3 } from './orient';
import type { TurnFix, TurnSearch } from './fixTurns';

/*
 * A learning record: what a program's clamping instructions say, how the app read them, and the
 * turns that made the simulated part like the real one (its 3D model). Saved on the server after
 * every turn search; an admin downloads them all to improve how the app reads written turns.
 * Only the instructions and the header are kept, not the program.
 */
export const LESSON_VERSION = 1;

export function lessonOf(tp: Toolpath, read: ProgramSetups, search: TurnSearch, fix: TurnFix | null) {
  const turned = (m: Mat3) => m.join(',');
  return {
    version: LESSON_VERSION,
    header: tp.header.slice(0, 12),
    stage: search.stage,
    simulations: search.count,
    found: search.match >= 0.99,
    setups: read.setups.map((s, k) => ({
      n: k + 1,
      line: s.line + 1,
      notes: s.notes,
      read: { orient: turned(s.orient), turns: s.turns, marker: s.marker, pers: s.pers, side: s.side, onEdge: s.onEdge, conflict: s.conflict },
      right: turned(search.orients[k]),
      changed: turned(s.orient) !== turned(search.orients[k]),
    })),
    corrected: fix?.changes.map((c) => ({ line: c.line + 1, from: c.from.trim(), to: c.to.trim() })) ?? [],
  };
}
export type Lesson = ReturnType<typeof lessonOf>;
