import type { Material, Tool, ToolCategory } from '../../types';
import type { CutRow, ShopKnowledge } from './learn';
import learned from './shopKnowledge.json';
import library from './library.json';
import type { Family, TemplateKind, TemplateTool } from './templates';
import { DEFAULT_LIMITS, type Limits } from './limits';
import { DEFLECTION, drillBuckling, drillThrust, materialData, millForce, PEAK, SAFETY, toolDeflection } from './physics';
export { DEFAULT_LIMITS, type Limits };

/*
 * The tools CAM AI may use: the shop's templates (tools/import-templates.ts, one family per
 * material) and the special tools an operator imported into the chosen machine. Nothing else.
 * Cutting data comes from the template of the right kind, capped to the machine's top rpm with the
 * feed lowered in proportion (same chip per tooth); special tools fall back on the values learned
 * from the shop's programs (tools/learn-shop.ts).
 */

export const knowledge = learned as unknown as ShopKnowledge;
export const LIBRARY = library as unknown as Record<Family, TemplateTool[]>;

/** The materials CAM AI cuts, and the template family each one is programmed with (shop rule). */
export const CAM_MATERIALS = ['ALU', 'MS', 'PCGF', 'POM', 'PEEK', 'FH', 'EPO', 'RESOPAL'] as const;
export type CamMaterial = (typeof CAM_MATERIALS)[number];
export const FAMILY: Record<CamMaterial, Family> = { ALU: 'ALU', MS: 'ALU', PCGF: 'ALU', POM: 'POM', PEEK: 'POM', FH: 'FH', EPO: 'FH', RESOPAL: 'FH' };
/** Inventory materials (Tool.materials) that count as a family's. */
const INVENTORY: Record<Family, Material[]> = { ALU: ['ALU', 'PC GF'], POM: ['POM'], FH: ['FH', 'RESOPAL', 'EPOXYDE'] };
/** Tool code suffix per family, as in the programs (SF_08.00_044_000_KS). */
const SUFFIX: Record<Family, string> = { ALU: 'ALHS', POM: 'KS', FH: 'FH' };

/** Template tool types -> inventory categories. */
const CATEGORY: Record<string, ToolCategory> = {
  SF: 'fraise',
  SFH: 'fraise',
  SB: 'foret',
  RA: 'foret',
  ZB: 'pointeur',
  AB: 'pointeur',
  ST: 'chanfrein',
  KS: 'chanfrein',
  MK: 'tourteau',
  KF: 'fraise boule',
  TF: 'fraise T',
  UDM: 'fraise rayon',
};
/** Inventory categories -> tool types, for special tools (not in the templates). */
export const TYPE_OF: Partial<Record<ToolCategory, string>> = {
  fraise: 'SF',
  'fraise ebauche': 'SF',
  'fraise finition': 'SF',
  foret: 'SB',
  pointeur: 'ZB',
  chanfrein: 'ST',
  tourteau: 'MK',
  'fraise boule': 'KF',
  'fraise T': 'TF',
  'fraise rayon': 'UDM',
};
const CODE_NAME: Record<string, string> = {
  SF: 'FRAESER',
  SFH: 'FRAESER',
  SB: 'BOHRER',
  RA: 'REIBAHLE',
  ZB: 'ZENTRIERBOHRER',
  AB: 'NC-ANBOHRER',
  ST: 'STICHEL',
  KS: 'KEGELSENKER',
  MK: 'MESSERKOPF',
  KF: 'KUGELFRAESER',
  TF: 'T-NUTENFRAESER',
  UDM: 'VIERTELKREISFRAESER',
};
export const MILLS = ['SF', 'SFH'];

/** A tool CAM AI may use: its code, and whether it is in the machine already. */
export interface CamTool extends Tool {
  code: string;
  type: string;
  template: TemplateTool | null;
  inMachine: boolean;
}

/** A machine tool is a template tool of this type (strict: a drill is never taken for a reamer). */
const sameType = (t: Tool, type: string) => (TYPE_OF[t.category] === 'SF' ? MILLS.includes(type) : TYPE_OF[t.category] === type);

/**
 * The tools for a material: every template tool of its family (with the machine's own number when
 * the machine has it), then the machine's special tools. `exclude`: codes the operator does not
 * have; `prefer`: codes the operator picked in their place (treated as in the machine).
 */
export function catalog(material: string, machine: Tool[], opts: { exclude?: string[]; prefer?: string[] } = {}): CamTool[] {
  const fam = FAMILY[material as CamMaterial];
  if (!fam) throw new Error(`Unknown CAM material ${material}`);
  const out: CamTool[] = [];
  const used = new Set<Tool>();
  // Every number in the machine is taken by the tool sitting there: a template tool that is not
  // in the machine never gets one of them (the shop's template numbers repeat the machines').
  const numbers = new Set<number>(machine.map((m) => m.number));
  for (const t of LIBRARY[fam]) {
    const category = CATEGORY[t.type];
    if (!category || opts.exclude?.includes(t.code)) continue;
    const m = machine.find((x) => !used.has(x) && sameType(x, t.type) && Math.abs(x.diameter - t.d) < 0.01 && Math.abs((x.length || 0) - t.length) <= 2);
    if (m) used.add(m);
    // One T number per tool in a program.
    let number = m?.number ?? t.number;
    while (!m && numbers.has(number)) number += 1_000_000;
    numbers.add(number);
    out.push({
      ...(m ?? {}),
      id: m?.id ?? t.code,
      number,
      category,
      description: m?.description ?? t.code,
      diameter: t.d,
      length: t.length,
      code: t.code,
      type: t.type,
      template: t,
      inMachine: !!m || !!opts.prefer?.includes(t.code),
    });
  }
  // Special tools imported into the machine (taps are not used).
  for (const m of machine) {
    const type = TYPE_OF[m.category];
    if (used.has(m) || !type || !(m.diameter > 0)) continue;
    if (m.materials?.length && !m.materials.some((x) => INVENTORY[fam].includes(x))) continue;
    const code = `${type}_${m.diameter.toFixed(2).padStart(5, '0')}_${String(Math.round(m.length || 0)).padStart(3, '0')}_000_${SUFFIX[fam]}`;
    if (opts.exclude?.includes(code)) continue;
    out.push({ ...m, code, type, template: null, inMachine: true });
  }
  return out;
}

/**
 * What can stand in for a tool the operator does not have: same type, the same Ø first (another
 * length at least as long), then the nearest smaller Ø (slower, never bigger: it might not fit
 * where the first one went); tools in the machine first.
 */
export function alternatives(material: string, machine: Tool[], code: string, exclude: string[] = []): CamTool[] {
  const all = catalog(material, machine, { exclude });
  const t = all.find((x) => x.code === code);
  if (!t) return [];
  return all
    .filter((x) => x.code !== code && x.type === t.type && x.length >= t.length - 0.01 && (MILLS.includes(t.type) ? x.diameter <= t.diameter + 0.001 : Math.abs(x.diameter - t.diameter) <= 0.12))
    .sort((a, b) => Math.abs(a.diameter - t.diameter) - Math.abs(b.diameter - t.diameter) || Number(b.inMachine) - Number(a.inMachine) || a.length - b.length)
    .slice(0, 4);
}

/** Tools of some types, largest first; for equal Ø the ones in the machine, then the shortest. */
export const usable = (tools: CamTool[], types: string[]) =>
  tools.filter((t) => types.includes(t.type)).sort((a, b) => b.diameter - a.diameter || Number(b.inMachine) - Number(a.inMachine) || a.length - b.length);

export interface Cut {
  s: number;
  /** Cutting feed, plunge/ramp feed (mm/min). */
  f: number;
  fz: number;
  /** Depth per pass, step-over (mm). */
  ap: number;
  ae: number;
  /** Peck (mm) for drills. */
  q: number;
  /** Where the values come from: the shop's template, its programs (learned / nearest Ø), or a default. */
  from: 'template' | 'learned' | 'nearest' | 'default';
  /** The template used (its name in the shop's programs). */
  template?: string;
}

/** The template kinds to look for, best first, for what an operation does. */
const NEAR: Partial<Record<TemplateKind, TemplateKind[]>> = {
  face: ['face', 'pocket', 'contour'],
  pocket: ['pocket', 'contour', 'finish'],
  contour: ['contour', 'pocket', 'finish'],
  finish: ['finish', 'contour', 'pocket'],
  drill: ['drill'],
  centre: ['centre', 'spot'],
  spot: ['spot', 'centre'],
  chamfer: ['chamfer', 'deburr', 'engrave'],
  deburr: ['deburr', 'chamfer'],
  engrave: ['engrave', 'chamfer', 'deburr'],
  counterbore: ['counterbore', 'pocket'],
};
/** Learned data has fewer kinds. */
const LEARNED_KIND: Partial<Record<TemplateKind, string>> = { spot: 'centre', deburr: 'chamfer', engrave: 'chamfer' };

const r10 = (v: number) => Math.max(10, Math.round(v / 10) * 10);

/** Cutting data for a tool doing `kind` on a material, within the machine's limits. */
export function cutData(tool: CamTool, kind: TemplateKind, material: string, limits: Limits = DEFAULT_LIMITS): Cut {
  return stiff(tool, kind, material, rawCut(tool, kind, material, limits));
}

/** The family's own material: the one its templates were made for. */
const BASE: Record<Family, CamMaterial> = { ALU: 'ALU', POM: 'POM', FH: 'FH' };
const MILL_KINDS = new Set<TemplateKind>(['face', 'contour', 'pocket', 'finish', 'tslot', 'ball', 'radius']);

/**
 * Within what the tool takes (physics.ts). A mill bends no more than its template on its own tool
 * in its own material (the shop runs it), else than the fixed limit (0.05 mm roughing, 0.01
 * finishing): the depth per pass comes down first (to 0.1 Ø), then the feed. A drill pushes no
 * harder than its template does (else a third of what it buckles under): its feed comes down.
 */
function stiff(tool: CamTool, kind: TemplateKind, material: string, c: Cut): Cut {
  const d = tool.diameter;
  const m = materialData(material);
  const L = tool.length || tool.template?.length || 3 * d;
  const fam = FAMILY[material as CamMaterial] ?? 'FH';
  const base = materialData(BASE[fam]);
  const templated = c.from === 'template' && !!tool.template;
  if (kind === 'drill' || kind === 'centre' || kind === 'spot') {
    const most = Math.max(drillBuckling(L, d) / SAFETY.buckle, templated ? drillThrust(base.kc, d, c.f, c.s) : 0);
    const thrust = drillThrust(m.kc, d, c.f, c.s);
    if (thrust <= most) return c;
    const k = most / thrust;
    return { ...c, f: Math.max(1, r10(c.f * k)), fz: Math.max(1, r10(c.fz * k)) };
  }
  if (!MILL_KINDS.has(kind)) return c;
  // A pocket starts with a full slot.
  const ae = kind === 'pocket' ? d : c.ae;
  const bend = (kc: number, len: number) => toolDeflection(PEAK * millForce(kc, c.ap, ae, c.f, c.s, d), len, d);
  const proven = templated ? bend(base.kc, tool.template!.length || L) : 0;
  const limit = Math.max(kind === 'finish' ? DEFLECTION.finish : DEFLECTION.rough, proven);
  const now = bend(m.kc, L);
  if (now <= limit * 1.0001) return c;
  // Force follows the depth and the feed alike.
  const ap = Math.min(c.ap, Math.max(0.1 * d, (c.ap * limit) / now));
  const k = Math.min(1, limit / now / (ap / c.ap));
  return { ...c, ap: Math.round(ap * 100) / 100, f: Math.max(1, r10(c.f * k)), fz: Math.max(1, r10(c.fz * k)) };
}

function rawCut(tool: CamTool, kind: TemplateKind, material: string, limits: Limits): Cut {
  const fam = FAMILY[material as CamMaterial] ?? 'FH';
  const d = tool.diameter;
  const op = (NEAR[kind] ?? [kind]).map((k) => tool.template?.ops.find((o) => o.kind === k)).find(Boolean);
  if (!op) return learnedCut(fam, tool.type, d, LEARNED_KIND[kind] ?? kind, limits);
  let s = op.rpm;
  let f = op.feed;
  // Over the machine's top rpm: slower, and the feed down in proportion (same chip per tooth).
  if (s > limits.maxRpm) {
    f *= limits.maxRpm / s;
    s = limits.maxRpm;
  }
  f = Math.min(limits.maxFeed, f);
  const ae = op.ae ? ('share' in op.ae ? op.ae.share * d : op.ae.mm) : d * 0.5;
  const drill = kind === 'drill' || kind === 'centre' || kind === 'spot';
  // Pecks are not in the templates: the shop's programs' (learned), else 1 × Ø.
  const q = drill ? learnedCut(fam, tool.type, d, 'drill', limits).q : d;
  return {
    s: Math.round(s / 50) * 50 || 100,
    f: r10(f),
    // Mills enter on a ramp at half the feed; drills plunge at their feed.
    fz: r10(drill ? f : f * 0.5),
    ap: Math.max(0.05, Math.round((op.ap ?? d * 0.25) * 100) / 100),
    ae: Math.max(0.05, Math.round(Math.min(ae, d * 0.95) * 100) / 100),
    q: Math.max(0.2, Math.round(q * 10) / 10),
    from: 'template',
    template: op.name,
  };
}

/** Cutting speed (m/min) and feed per tooth (mm) to fall back on, per family. */
const DEFAULTS: Record<Family, { vc: number; fz: number }> = { ALU: { vc: 250, fz: 0.03 }, POM: { vc: 200, fz: 0.04 }, FH: { vc: 120, fz: 0.03 } };

/** From the shop's programs (special tools, kinds the templates do not have). */
function learnedCut(fam: Family, type: string, d: number, kind: string, limits: Limits): Cut {
  const rows: CutRow[] = knowledge.cut[fam]?.[type === 'SFH' ? 'SF' : type] ?? [];
  const same = rows.filter((r) => r.kind === kind);
  const pool = same.length ? same : rows;
  const exact = pool.find((r) => Math.abs(r.d - d) < 0.01);
  const near = exact ?? [...pool].sort((a, b) => Math.abs(Math.log(a.d / d)) - Math.abs(Math.log(b.d / d)))[0];
  const from: Cut['from'] = exact ? 'learned' : near ? 'nearest' : 'default';
  const dflt = DEFAULTS[fam];
  // From the nearest Ø: same cutting speed and feed per tooth, so rpm and feed scale with 1/Ø.
  const k = near ? near.d / d : 1;
  let s = near?.s ? near.s * k : (dflt.vc * 1000) / (Math.PI * d);
  let f = near?.f ? near.f * k : s * dflt.fz * 2;
  let fz = near?.fz ? near.fz * k : f / 3;
  if (s > limits.maxRpm) {
    f *= limits.maxRpm / s;
    fz *= limits.maxRpm / s;
    s = limits.maxRpm;
  }
  const ratio = near ? d / near.d : 1;
  const ap = Math.min(d, (near?.ap ?? d * 0.25) * ratio);
  const ae = Math.min(d * 0.9, (near?.ae ?? d * 0.5) * ratio);
  const q = (near?.q ?? d) * ratio;
  f = Math.min(limits.maxFeed, f);
  fz = Math.min(limits.maxFeed, fz);
  return { s: Math.round(s / 50) * 50 || 100, f: r10(f), fz: r10(fz), ap: Math.max(0.1, Math.round(ap * 100) / 100), ae: Math.max(0.05, Math.round(ae * 100) / 100), q: Math.max(0.2, Math.round(q * 10) / 10), from };
}

/** The tool comment of the programs: "8MM FRAESER/44MM LANG / SF_08.00_044_000_KS". */
export function toolComment(t: CamTool): string {
  return `${String(Math.round(t.diameter * 100) / 100).replace('.', ',')}MM ${CODE_NAME[t.type] ?? 'WERKZEUG'}/${Math.round(t.length || 0)}MM LANG / ${t.code}`;
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
