/*
 * A program opened in CAM AI (you, Beta 2: item 3): an engineer's, not CAM AI's own. Cut into runs of one tool each
 * (tool change to tool change), and changed by hand run by run with the same edits as CAM AI's own operations
 * (opEdit.ts: moved X, Y, Z or taken deeper; never a tool change, machine position, length offset or comment).
 * The page simulates and checks the result again, as it does every program.
 */
import { editOpLines, type OpEdit } from './opEdit';

export interface Run {
  /** Its tool number and its description (the comment on the tool change), lines from..to (0-based, inclusive). */
  tool: number | null;
  label: string;
  from: number;
  to: number;
}

const TOOL_CHANGE = /^\s*(?:N\d+\s*)?T(\d+)\s*M0?6\b/i;

export function runsOf(code: string): Run[] {
  const lines = code.split('\n');
  const runs: Run[] = [];
  lines.forEach((l, i) => {
    const m = l.match(TOOL_CHANGE);
    if (!m) return;
    if (runs.length) runs[runs.length - 1].to = i - 1;
    runs.push({ tool: Number(m[1]), label: l.match(/\(([^)]*)\)/)?.[1]?.trim() ?? '', from: i, to: lines.length - 1 });
  });
  // A run ends at its last move before the program's end (the machine positions and M30 after it stay).
  const last = runs[runs.length - 1];
  if (last) {
    let k = last.to;
    while (k > last.from && /^\s*(%|M30|M02|G53|G28|G91\s*G28|$)/i.test(lines[k].replace(/^N\d+\s*/, ''))) k--;
    last.to = k;
  }
  return runs;
}

/** The program with one run changed by hand; every other line as it was. */
export function editRun(code: string, run: Run, e: OpEdit): string {
  const lines = code.split('\n');
  const changed = editOpLines(lines.slice(run.from, run.to + 1), e);
  return [...lines.slice(0, run.from), ...changed, ...lines.slice(run.to + 1)].join('\n');
}
