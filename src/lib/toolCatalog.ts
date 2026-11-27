import { type Material, type Tool, type ToolCategory } from '../types';

/*
 * A country's tool database (Türkiye's, A032-A034): the shop's tools by their code, read from the shop's list.
 * A code says what the tool is: SF_08.00_044_000_KS is a finishing end mill (SF), Ø8, 44 mm long, no radius or
 * angle (000; R03 a radius, G45 an angle, T1.5 a width, 001 a tap's pitch), for the KS group (POM). Users add a tool to a machine by
 * narrowing dropdowns until one tool is left. No cutting data is kept (A032). The server checks a saved list
 * with the same code as the page (normalizeCatalogTool).
 */

/** Code prefix → tool type. The remapper reads a program's tool calls with it too. */
export const PREFIX_TO_CATEGORY: Record<string, ToolCategory> = {
  ST: 'chanfrein',
  SB: 'foret',
  ZB: 'pointeur',
  GB: 'taraud',
  SF: 'fraise finition',
  SFH: 'fraise ebauche',
  KF: 'fraise boule',
  MK: 'tourteau',
  TF: 'fraise T',
  UDM: 'fraise rayon',
  // A033: a reamer is its own type (never put in for a drill), a 90° countersink a chamfer tool, SR a roughing mill.
  RA: 'alesoir',
  KS: 'chanfrein',
  SR: 'fraise ebauche',
};

/** Order of the types in the dropdown: drills first, then mills, then the rest. */
const TYPE_ORDER = ['SB', 'AB', 'ZB', 'GB', 'RA', 'SF', 'SFH', 'SR', 'KF', 'UDM', 'TF', 'ST', 'KS', 'MK'];

export const CATALOG_MATERIALS = ['ALU', 'BRASS', 'PCGF', 'EPOXY', 'PEEK', 'POM', 'FH', 'RESOPAL', 'INOX'] as const;
export type CatalogMaterial = (typeof CATALOG_MATERIALS)[number];

/** The owner's legend of the code's last part. */
const GROUP_MATERIALS: Record<string, CatalogMaterial[]> = {
  AL: ['ALU'],
  ALHS: ['ALU', 'PCGF', 'EPOXY', 'BRASS', 'PEEK'],
  FH: ['FH', 'EPOXY'],
  KS: ['POM'],
  KSHS: ['PCGF'],
  VAHS: ['INOX'],
};

/** Words of the list's NX menu column ("Aluminum/Ms58-Chiron", "Fh/Rspl-Haas", "VA-1.4305-Chiron/Haas"). */
const MENU_WORDS: Record<string, CatalogMaterial> = {
  aluminum: 'ALU',
  aluminium: 'ALU',
  alu: 'ALU',
  ms58: 'BRASS',
  pcgf: 'PCGF',
  epoxid: 'EPOXY',
  epoxy: 'EPOXY',
  peek: 'PEEK',
  pom: 'POM',
  fh: 'FH',
  rspl: 'RESOPAL',
  resopal: 'RESOPAL',
  va: 'INOX',
  '1.4305': 'INOX',
  inox: 'INOX',
};

/** The inventory's own material marks (the remapper prefers a tool marked for the program's material). */
const TOOL_MATERIAL: Partial<Record<CatalogMaterial, Material>> = { ALU: 'ALU', PCGF: 'PC GF', EPOXY: 'EPOXYDE', POM: 'POM', FH: 'FH', RESOPAL: 'RESOPAL' };

export interface CatalogTool {
  code: string;
  /** The code's prefix (SF, SB, ...). */
  type: string;
  category: ToolCategory;
  diameter: number;
  length: number;
  /** Radius (R3), angle (45°), pitch (P1) or width (T1.5) from the code; '' when it has none. */
  extra: string;
  flutes: number | null;
  materials: CatalogMaterial[];
  description: string;
}

const CODE = /^([A-Z]{1,4})_(\d{1,3}\.\d{1,2})_(\d{1,4})_(\d{3}|[RGT]\d{1,3}(?:\.\d{1,2})?)_([A-Z]{1,6})$/;

/** What a code says, or null when it is not a tool code. */
export function readCode(code: string): { type: string; diameter: number; length: number; extra: string; angle: number | null; group: string } | null {
  const m = CODE.exec(code);
  if (!m) return null;
  const [, type, d, l, x, group] = m;
  const n = Number(/^\d/.test(x) ? x : x.slice(1));
  // 000 nothing; a number a tap's pitch (GB_08.00_065_001: M8×1); R a radius, G an angle, T a width.
  const extra = x === '000' ? '' : /^\d/.test(x) ? `P${n}` : x[0] === 'R' ? `R${n}` : x[0] === 'G' ? `${n}°` : `T${n}`;
  return { type, diameter: Number(d), length: Number(l), extra, angle: x[0] === 'G' ? n : null, group };
}

/** The tool's type from its prefix; AB is a drill with a drill's point (118° and more), else a spot drill. */
export function categoryOf(type: string, angle: number | null): ToolCategory | null {
  if (type === 'AB') return angle !== null && angle >= 118 ? 'foret' : 'pointeur';
  return PREFIX_TO_CATEGORY[type] ?? null;
}

export const MAX_CATALOG_TOOLS = 3000;

/**
 * One entry as the server keeps it, or null when it is not one. What the code says (type, length, radius or angle,
 * tool type) is taken from the code, never from the sender; the Ø may differ from the code's (the list's own Ø).
 */
export function normalizeCatalogTool(raw: unknown): CatalogTool | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const code = typeof r.code === 'string' ? r.code.trim().toUpperCase() : '';
  const c = readCode(code);
  const category = c && categoryOf(c.type, c.angle);
  if (!c || !category) return null;
  const diameter = Number(r.diameter);
  if (!Number.isFinite(diameter) || diameter <= 0 || diameter > 500) return null;
  const flutes = r.flutes === null || r.flutes === undefined || r.flutes === '' ? null : Number(r.flutes);
  if (flutes !== null && !(Number.isInteger(flutes) && flutes >= 1 && flutes <= 60)) return null;
  const materials = Array.isArray(r.materials) ? CATALOG_MATERIALS.filter((m) => (r.materials as unknown[]).includes(m)) : [];
  // eslint-disable-next-line no-control-regex
  const description = typeof r.description === 'string' ? r.description.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120) : '';
  return { code, type: c.type, category, diameter, length: c.length, extra: c.extra, flutes, materials, description };
}

/** A whole list as the server keeps it, or null when any entry is not one, or a code comes twice. */
export function normalizeCatalog(raw: unknown): CatalogTool[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_CATALOG_TOOLS) return null;
  const out: CatalogTool[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const t = normalizeCatalogTool(r);
    if (!t || seen.has(t.code)) return null;
    seen.add(t.code);
    out.push(t);
  }
  return out;
}

// ---- Reading the shop's list ----------------------------------------------------------------------

/** A CSV file's rows (commas or, as Excel writes it in Turkish, semicolons; quoted cells). */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, '');
  const first = s.slice(0, s.search(/\r|\n|$/));
  const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (s[i + 1] === '"') (cell += '"'), i++;
      else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) row.push(cell), (cell = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows;
}

export type CatalogNoteKind = 'badCode' | 'unknownType' | 'diameter' | 'length' | 'description' | 'noMaterial';
/** Something in the list the owner may want to fix (the tool is still read, except badCode and unknownType). */
export interface CatalogNote {
  /** Row in the file (1 = the header). */
  row: number;
  code: string;
  kind: CatalogNoteKind;
  /** The two values that differ (diameter, length, description). */
  a?: string;
  b?: string;
}

const fold = (s: string) => s.toLocaleLowerCase('en').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i').trim();
const num = (s: string | undefined) => (s === undefined || s.trim() === '' ? NaN : Number(s.trim().replace(',', '.')));

/**
 * The tools of the shop's list (one per code; a code on several rows gets every row's materials) and what in it
 * may need fixing. The code column is the one most cells of which are tool codes; the others are found by name
 * (Turkish, English or German).
 */
export function catalogFromRows(rows: string[][]): { tools: CatalogTool[]; notes: CatalogNote[] } {
  const cellsAt = (i: number) => rows.slice(1).map((r) => (r[i] ?? '').trim().toUpperCase());
  const width = Math.max(0, ...rows.slice(0, 50).map((r) => r.length));
  let codeCol = -1;
  let best = 0;
  for (let i = 0; i < width; i++) {
    const hits = cellsAt(i).filter((c) => CODE.test(c)).length;
    if (hits > best) (best = hits), (codeCol = i);
  }
  if (codeCol < 0) return { tools: [], notes: [] };
  const head = (rows[0] ?? []).map(fold);
  const col = (...names: RegExp[]) => head.findIndex((h, i) => i !== codeCol && names.some((n) => n.test(h)));
  const menuCol = col(/\bnx\b/, /^malzeme\b/, /^material\b/);
  const descCol = col(/^aciklama/, /^description/, /^beschreibung/, /^bezeichnung/);
  const diaCol = col(/^cap\b/, /^diameter/, /^durchmesser/, /^ø/);
  const flutesCol = col(/^agiz/, /^flutes/, /^schneiden/, /^z$/);

  const byCode = new Map<string, CatalogTool & { row: number }>();
  const notes: CatalogNote[] = [];
  rows.forEach((r, idx) => {
    if (idx === 0) return;
    const row = idx + 1;
    const code = (r[codeCol] ?? '').trim().toUpperCase();
    if (!code) return;
    const c = readCode(code);
    if (!c) return void notes.push({ row, code, kind: 'badCode' });
    const category = categoryOf(c.type, c.angle);
    if (!category) return void notes.push({ row, code, kind: 'unknownType' });
    const menu = menuCol >= 0 ? (r[menuCol] ?? '') : '';
    const materials = new Set<CatalogMaterial>(GROUP_MATERIALS[c.group] ?? []);
    for (const w of fold(menu).split(/[/\s-]+/)) if (MENU_WORDS[w]) materials.add(MENU_WORDS[w]);
    const description = descCol >= 0 ? (r[descCol] ?? '').trim() : '';
    const had = byCode.get(code);
    if (had) {
      for (const m of materials) if (!had.materials.includes(m)) had.materials.push(m);
      if (description && had.description && description !== had.description) notes.push({ row, code, kind: 'description', a: had.description, b: description });
      return;
    }
    const listed = num(diaCol >= 0 ? r[diaCol] : undefined);
    const diameter = listed > 0 ? listed : c.diameter;
    // The list's own Ø (and its description) win over the code's: the code names the tool, the Ø column measures it.
    if (listed > 0 && Math.abs(listed - c.diameter) > 1e-6) notes.push({ row, code, kind: 'diameter', a: String(c.diameter), b: String(listed) });
    const said = /\/\s*(\d+(?:[.,]\d+)?)\s*mm\s*lang/i.exec(description);
    if (said && Math.abs(num(said[1]) - c.length) > 1e-6) notes.push({ row, code, kind: 'length', a: String(c.length), b: String(num(said[1])) });
    const flutes = num(flutesCol >= 0 ? r[flutesCol] : undefined);
    byCode.set(code, {
      row,
      code,
      type: c.type,
      category,
      diameter,
      length: c.length,
      extra: c.extra,
      flutes: Number.isInteger(flutes) && flutes >= 1 && flutes <= 60 ? flutes : null,
      materials: [...materials],
      description: description.slice(0, 120),
    });
  });
  const tools = [...byCode.values()].map(({ row, ...t }) => {
    if (!t.materials.length) notes.push({ row, code: t.code, kind: 'noMaterial' });
    return { ...t, materials: CATALOG_MATERIALS.filter((m) => t.materials.includes(m)) };
  });
  return { tools: sortCatalog(tools), notes: notes.sort((a, b) => a.row - b.row) };
}

const typeRank = (type: string) => (TYPE_ORDER.indexOf(type) + 1 || TYPE_ORDER.length + 1);
export function sortCatalog(tools: CatalogTool[]): CatalogTool[] {
  return [...tools].sort((a, b) => typeRank(a.type) - typeRank(b.type) || a.diameter - b.diameter || a.length - b.length || a.code.localeCompare(b.code));
}

// ---- Narrowing dropdowns ---------------------------------------------------------------------------

export const FACETS = ['type', 'diameter', 'length', 'material', 'extra', 'flutes'] as const;
export type Facet = (typeof FACETS)[number];
export type Picks = Partial<Record<Facet, string>>;

export function facetValues(t: CatalogTool, f: Facet): string[] {
  switch (f) {
    case 'type':
      return [t.type];
    case 'diameter':
      return [String(t.diameter)];
    case 'length':
      return [String(t.length)];
    case 'material':
      return t.materials;
    case 'extra':
      return t.extra ? [t.extra] : [];
    case 'flutes':
      return t.flutes ? [String(t.flutes)] : [];
  }
}

/** The tools every pick allows (but the one left out: its own dropdown lists what the others allow). */
export function matchingTools(tools: CatalogTool[], picks: Picks, except?: Facet): CatalogTool[] {
  return tools.filter((t) => FACETS.every((f) => f === except || !picks[f] || facetValues(t, f).includes(picks[f]!)));
}

const extraRank = (v: string) => ({ R: 1, P: 3, T: 4 })[v[0] as 'R' | 'P' | 'T'] ?? 2;
/** A dropdown's choices with how many tools each leaves, given the other picks. */
export function facetOptions(tools: CatalogTool[], picks: Picks, f: Facet): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const t of matchingTools(tools, picks, f)) for (const v of facetValues(t, f)) counts.set(v, (counts.get(v) ?? 0) + 1);
  const order = (a: string, b: string) =>
    f === 'type'
      ? typeRank(a) - typeRank(b) || a.localeCompare(b)
      : f === 'material'
        ? CATALOG_MATERIALS.indexOf(a as CatalogMaterial) - CATALOG_MATERIALS.indexOf(b as CatalogMaterial)
        : f === 'extra'
          ? extraRank(a) - extraRank(b) || parseFloat(a.replace(/^[RPT]/, '')) - parseFloat(b.replace(/^[RPT]/, ''))
          : Number(a) - Number(b);
  return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => order(a.value, b.value));
}

// ---- Into a machine --------------------------------------------------------------------------------

/**
 * The slot a new tool goes to (A034): the one after the last tool, or 1; past the machine's slots, the first free
 * one; null when every slot is taken. Empty slots count as free.
 */
export function nextSlot(tools: Pick<Tool, 'number' | 'category'>[], pockets: number | null | undefined): number | null {
  const used = new Set(tools.filter((t) => t.category !== 'empty').map((t) => t.number));
  const next = Math.max(0, ...used) + 1;
  if (!pockets || next <= pockets) return next;
  for (let s = 1; s <= pockets; s++) if (!used.has(s)) return s;
  return null;
}

/** The inventory tool a database entry becomes in a slot. */
export function toolFromCatalog(e: CatalogTool, slot: number, id: string): Tool {
  const materials = e.materials.map((m) => TOOL_MATERIAL[m]).filter((m): m is Material => !!m);
  const tool: Tool = { id, number: slot, category: e.category, description: e.code, diameter: e.diameter, length: e.length, changed: true };
  if (materials.length) tool.materials = materials;
  return tool;
}
