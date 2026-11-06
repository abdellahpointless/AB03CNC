import type { Tool, ToolCategory } from '../../types';
import type { CutRow, OpKind, ShopKnowledge } from './learn';
import learned from './shopKnowledge.json';

/*
 * Which tool of the machine's inventory does what, and at which rpm, feeds, depth per pass and
 * step-over: the shop's own values (learned from its programs, see tools/learn-shop.ts) for that
 * material, tool type and Ø, else the nearest Ø learned, else a careful default; never over the
 * machine's limits.
 */

export const knowledge = learned as unknown as ShopKnowledge;

/** Inventory categories (French) -> the shop's tool type codes in the programs. */
export const TYPE_OF: Partial<Record<ToolCategory, string>> = {
  fraise: 'SF',
  'fraise ebauche': 'SF',
  'fraise finition': 'SF',
  foret: 'SB',
  pointeur: 'ZB',
  chanfrein: 'ST',
  tourteau: 'MK',
  taraud: 'GB',
  'fraise boule': 'KF',
};
const CODE_NAME: Record<string, string> = { SF: 'FRAESER', SB: 'BOHRER', ZB: 'ZENTRIERBOHRER', ST: 'STICHEL', MK: 'MESSERKOPF', GB: 'GEWINDEBOHRER', KF: 'KUGELFRAESER' };
/** Tool code suffix per material, as in the programs (SF_08.00_044_000_FH). */
const SUFFIX: Record<string, string> = { FH: 'FH', POM: 'KS', ALU: 'ALHS', 'PC GF': 'KS', RESOPAL: 'FH', EPOXYDE: 'FH' };

import { DEFAULT_LIMITS, type Limits } from './limits';
export { DEFAULT_LIMITS, type Limits };

export interface Cut {
  s: number;
  /** Cutting feed, plunge feed (mm/min). */
  f: number;
  fz: number;
  /** Depth per pass, step-over (mm). */
  ap: number;
  ae: number;
  /** Peck (mm) for drills. */
  q: number;
  /** Where the values come from: learned for this Ø, learned nearest Ø, or default. */
  from: 'learned' | 'nearest' | 'default';
}

/** Cutting speed (m/min) and feed per tooth (mm) to fall back on, per material. */
const DEFAULTS: Record<string, { vc: number; fz: number }> = { ALU: { vc: 250, fz: 0.03 }, POM: { vc: 200, fz: 0.04 }, FH: { vc: 120, fz: 0.03 } };

export function cutData(material: string, type: string, d: number, kind: OpKind, limits: Limits = DEFAULT_LIMITS): Cut {
  const rows: CutRow[] = knowledge.cut[material]?.[type] ?? [];
  const same = rows.filter((r) => r.kind === kind);
  const pool = same.length ? same : rows;
  const exact = pool.find((r) => Math.abs(r.d - d) < 0.01);
  const near = exact ?? [...pool].sort((a, b) => Math.abs(Math.log(a.d / d)) - Math.abs(Math.log(b.d / d)))[0];
  const from: Cut['from'] = exact ? 'learned' : near ? 'nearest' : 'default';
  const dflt = DEFAULTS[material] ?? DEFAULTS.FH;
  // From the nearest Ø: same cutting speed and feed per tooth, so rpm and feed scale with 1/Ø.
  const k = near ? near.d / d : 1;
  let s = near?.s ? near.s * k : (dflt.vc * 1000) / (Math.PI * d);
  let f = near?.f ? near.f * k : s * dflt.fz * 2;
  let fz = near?.fz ? near.fz * k : f / 3;
  const ratio = near ? d / near.d : 1;
  const ap = Math.min(d, (near?.ap ?? d * 0.25) * ratio);
  const ae = Math.min(d * 0.9, (near?.ae ?? d * 0.5) * ratio);
  const q = (near?.q ?? d) * ratio;
  s = Math.min(limits.maxRpm, s);
  f = Math.min(limits.maxFeed, f);
  fz = Math.min(limits.maxFeed, fz);
  const r10 = (v: number) => Math.max(10, Math.round(v / 10) * 10);
  return { s: Math.round(s / 50) * 50 || 100, f: r10(f), fz: r10(fz), ap: Math.max(0.1, Math.round(ap * 100) / 100), ae: Math.max(0.05, Math.round(ae * 100) / 100), q: Math.max(0.2, Math.round(q * 10) / 10), from };
}

/** The tool comment of the programs: "8MM FRAESER/44MM LANG / SF_08.00_044_000_FH". */
export function toolComment(t: Tool, material: string): string {
  const type = TYPE_OF[t.category] ?? 'SF';
  const d = t.diameter.toFixed(2).padStart(5, '0');
  const len = String(Math.round(t.length || 0)).padStart(3, '0');
  // The graver's point in its code as the shop writes it ("_G45_": 45° per side, read back by the viewer).
  return `${String(Math.round(t.diameter * 100) / 100).replace('.', ',')}MM ${CODE_NAME[type] ?? 'WERKZEUG'}/${Math.round(t.length || 0)}MM LANG / ${type}_${d}_${len}_${type === 'ST' ? 'G45' : '000'}_${SUFFIX[material] ?? 'FH'}`;
}

export interface Need {
  /** What is missing: a tool type and Ø, the length it needs, and what for. */
  category: ToolCategory;
  diameter: number;
  minLength: number;
  /** What for (camAi.why.* on the page): with a hole's Ø and depth, a volume, a count. */
  why: { key: 'face' | 'hole' | 'holeMilled' | 'narrow' | 'chamfer'; d?: number; depth?: number; mm3?: number; count?: number };
}

/** What CAM AI did not program (camAi.note.* on the page). */
export interface CamNote {
  key: 'undercut' | 'notSimulated' | 'surface';
  side?: string;
  mm3?: number;
  mm2?: number;
}

/** Tools of a category usable on this material, longest reach first for equal Ø. */
export const usable = (tools: Tool[], cats: ToolCategory[], material: string) =>
  tools
    .filter((t) => cats.includes(t.category) && t.diameter > 0 && (!t.materials?.length || t.materials.includes(material as never)))
    .sort((a, b) => b.diameter - a.diameter || b.length - a.length);

export const MILLS: ToolCategory[] = ['fraise', 'fraise ebauche', 'fraise finition'];
