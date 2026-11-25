import type { Family, TemplateKind } from './templates';

/*
 * The shop's own changes to CAM AI's tool database (item 20, the Tool database dialog), kept in the country's
 * database (worker/routes/lab.ts) and checked there and here again before the planner sees them (tools.ts,
 * catalog). A template tool can be removed, or given its own cutting data per kind of operation; a tool can be
 * added, of the types the planner plans with. Saved values are never taken as a template's own: they are
 * checked as values typed into the tool inspector are (cutData: within the machine, unsafe when too much).
 */

export const FAMILIES: Family[] = ['ALU', 'POM', 'FH'];
/** Tool code suffix per family, as in the programs (SF_08.00_044_000_KS). */
export const SUFFIX: Record<Family, string> = { ALU: 'ALHS', POM: 'KS', FH: 'FH' };
/**
 * What may be added, with its shape field: the types the planner plans with (program.ts: end mills, the face
 * mill, drills, the centre drill, the 45° graver that cuts chamfers). Ball, radius, T-slot mills, reamers and
 * countersinks are shown, never added: the planner does not plan with them.
 */
export const ADDABLE: Record<string, string> = { SF: '000', SFH: '000', MK: '000', SB: '000', ZB: '000', ST: 'G45' };
/** The operations an added tool of each type does (the rows of its cutting data). */
export const KINDS_OF: Record<string, TemplateKind[]> = { SF: ['contour', 'pocket', 'finish'], SFH: ['contour', 'pocket'], MK: ['face'], SB: ['drill'], ZB: ['centre'], ST: ['chamfer'] };
export const KINDS: TemplateKind[] = ['face', 'contour', 'pocket', 'finish', 'drill', 'centre', 'spot', 'ream', 'counterbore', 'chamfer', 'deburr', 'engrave', 'countersink', 'radius', 'tslot', 'ball'];

/** Spindle (rpm), feed (mm/min), step-over and depth per pass (mm); unset: the template's. */
export interface DbCut {
  s?: number;
  f?: number;
  ae?: number;
  ap?: number;
}
export interface DbTool {
  removed?: boolean;
  /** Switched off by the shop: kept here, never planned with (item 14). */
  off?: true;
  /** Roughing only (never a finishing pass) or finishing first for its Ø; unset: both (item 14). */
  role?: 'rough' | 'finish';
  cuts?: Partial<Record<TemplateKind, DbCut>>;
  /** A tool the shop added: its type, Ø and length out of the holder (mm). */
  added?: { type: string; d: number; length: number };
}
/** Per family, per tool code. */
export type ToolDb = Partial<Record<Family, Record<string, DbTool>>>;

const RANGE: Record<keyof DbCut, [number, number]> = { s: [100, 60000], f: [1, 30000], ae: [0.01, 100], ap: [0.01, 100] };
// Written into the programs' tool comments: letters, digits, dots and underscores only.
const CODE = /^[A-Z]{2,3}_\d{2,3}\.\d{2}_\d{3}_[A-Z0-9.]{1,5}_(ALHS|KS|FH)$/;

export const codeOf = (type: string, d: number, length: number, fam: Family) =>
  `${type}_${d.toFixed(2).padStart(5, '0')}_${String(Math.round(length)).padStart(3, '0')}_${ADDABLE[type] ?? '000'}_${SUFFIX[fam]}`;

const inRange = (v: unknown, [lo, hi]: [number, number]): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/** A stored tool as the planner may take it (unknown fields dropped), or null: anything unknown or out of range. */
export function cleanDbTool(fam: unknown, code: unknown, raw: unknown): DbTool | null {
  if (!FAMILIES.includes(fam as Family) || typeof code !== 'string' || !CODE.test(code) || !raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const out: DbTool = {};
  if (r.removed !== undefined) {
    if (r.removed !== true || r.cuts !== undefined || r.added !== undefined || r.off !== undefined || r.role !== undefined) return null;
    return { removed: true };
  }
  if (r.off !== undefined) {
    if (r.off !== true) return null;
    out.off = true;
  }
  if (r.role !== undefined) {
    if (r.role !== 'rough' && r.role !== 'finish') return null;
    out.role = r.role;
  }
  if (r.added !== undefined) {
    const a = r.added as Record<string, unknown> | null;
    if (!a || typeof a !== 'object' || typeof a.type !== 'string' || !(a.type in ADDABLE) || !inRange(a.d, [0.5, 160]) || !inRange(a.length, [5, 300])) return null;
    if (codeOf(a.type, a.d, a.length, fam as Family) !== code) return null;
    out.added = { type: a.type, d: a.d, length: Math.round(a.length) };
  }
  if (r.cuts !== undefined) {
    if (!r.cuts || typeof r.cuts !== 'object') return null;
    const cuts: Partial<Record<TemplateKind, DbCut>> = {};
    for (const [kind, c] of Object.entries(r.cuts as Record<string, unknown>)) {
      if (!KINDS.includes(kind as TemplateKind) || !c || typeof c !== 'object') return null;
      const v = c as Record<string, unknown>;
      const cut: DbCut = {};
      for (const k of Object.keys(RANGE) as (keyof DbCut)[]) {
        if (v[k] === undefined) continue;
        if (!inRange(v[k], RANGE[k])) return null;
        cut[k] = k === 's' || k === 'f' ? Math.round(v[k] as number) : (v[k] as number);
      }
      if (Object.keys(cut).length) cuts[kind as TemplateKind] = cut;
    }
    if (Object.keys(cuts).length) out.cuts = cuts;
  }
  return Object.keys(out).length ? out : null;
}
