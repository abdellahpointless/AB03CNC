/*
 * The comment the app's own program planner writes as a program's first line, so the remapper keeps its
 * tool numbers (they are the machine's, as simulated). It names nothing; programs written before it carry
 * the older one, still read.
 */
export const PROGRAM_MARK = '(3D-MODELL)';

/** Whether a program carries the planner's mark (on its own line, numbered or not). */
export const hasProgramMark = (code: string): boolean => /^\s*(?:N\d+\s*)?\((?:3D-MODELL|CAM\x20AI)\)/m.test(code);

/** Whether a parsed program's header (its comments, brackets off) is the planner's: its heights are exact. */
export const markedHeader = (header: readonly string[]): boolean => header.some((h) => /^(?:3D-MODELL|CAM\x20AI)$/.test(h.trim()));
