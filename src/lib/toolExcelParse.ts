import { MACHINES, MATERIALS, TOOL_CATEGORIES, Tool } from '../types';

/*
 * Excel import for the tool inventory: turns the rows of a worksheet into tools, one list per
 * machine, and reports every problem with its row number. Pure functions (no Excel library),
 * so they can be unit tested.
 *
 * Sheet layout (first row = headers, one tool per row):
 *   Machine | T-Number | Pocket | Category | Description | Diameter | Length | Materials
 */

export const TEMPLATE_HEADERS = ['Machine', 'T-Number', 'Pocket', 'Category', 'Description', 'Diameter (mm)', 'Length (mm)', 'Materials'] as const;

/** Machines that have a tool inventory in the app. */
export const IMPORT_MACHINES: string[] = [...MACHINES];

export const CATEGORY_HELP: Record<string, string> = {
  foret: 'Drill',
  'fraise ebauche': 'Roughing end mill',
  pointeur: 'Center drill / spotting drill',
  fraise: 'End mill',
  chanfrein: 'Chamfer mill',
  tourteau: 'Face mill',
  'fraise finition': 'Finishing end mill',
  taraud: 'Tap',
  'fraise boule': 'Ball-nose end mill',
  'fraise T': 'T-slot cutter',
  'fraise rayon': 'Corner-radius end mill',
  empty: 'Empty slot (no tool)',
};

export const EXAMPLE_ROWS: (string | number)[][] = [
  ['HAAS-1', 1, 1, 'fraise', 'Fraise D6', 6, 33, 'ALU, POM'],
  ['HAAS-1', 2, 2, 'foret', 'Foret D4.2', 4.2, 55, ''],
  ['HAAS-1', 3, 3, 'taraud', 'Taraud M5', 5, 0, 'ALU'],
  ['HAAS-1', 4, '', 'empty', '', '', '', ''],
  ['FANUC-1', 1, '', 'tourteau', 'Tourteau D63', 63, 0, ''],
];

export interface ParsedToolRow {
  row: number;
  machine: string;
  tool: Omit<Tool, 'id'>;
}

export interface ParseResult {
  tools: ParsedToolRow[];
  errors: { row: number; message: string }[];
  /** Tools grouped by machine, ready to send to the server. */
  byMachine: Record<string, Omit<Tool, 'id'>[]>;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const HEADER_ALIASES: Record<string, string[]> = {
  machine: ['machine', 'machinename', 'machineid', 'machin'],
  number: ['tnumber', 'tnum', 'toolnumber', 'tool', 'number', 'no', 't', 'tnr'],
  pocket: ['pocket', 'slot', 'pocketnumber', 'magazine'],
  category: ['category', 'type', 'categorie', 'toolcategory', 'tooltype'],
  description: ['description', 'name', 'toolname', 'desc', 'designation'],
  diameter: ['diameter', 'diametermm', 'dia', 'diam', 'd'],
  length: ['length', 'lengthmm', 'len', 'l'],
  materials: ['materials', 'material', 'matiere', 'matieres'],
};

/** Finds which column holds what, from the header row. Returns null if a required column is missing. */
export function mapHeaders(headerRow: string[]): { map: Record<string, number>; missing: string[] } {
  const map: Record<string, number> = {};
  headerRow.forEach((h, i) => {
    const n = norm(h);
    if (!n) return;
    for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
      if (map[key] === undefined && aliases.map(norm).includes(n)) map[key] = i;
    }
  });
  const missing = ['machine', 'number', 'category'].filter((k) => map[k] === undefined);
  return { map, missing };
}

/** "haas 1", "Haas_1", "HAAS-1" -> "HAAS-1". Returns null for machines that do not exist. */
export function matchMachine(raw: string): string | null {
  const n = norm(raw);
  return IMPORT_MACHINES.find((m) => norm(m) === n) ?? null;
}

export function matchCategory(raw: string): string | null {
  const n = norm(raw);
  if (!n) return null;
  return TOOL_CATEGORIES.find((c) => norm(c) === n) ?? null;
}

/** Accepts "6.5" and "6,5". Returns NaN for text that is not a number, null for blank. */
function toNumber(raw: string): number | null {
  const t = raw.trim().replace(',', '.');
  if (t === '') return null;
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
}

/** Rows are arrays of cell texts; rows[0] is the header row. */
export function parseToolRows(rows: string[][]): ParseResult {
  const result: ParseResult = { tools: [], errors: [], byMachine: {} };
  if (!rows.length) {
    result.errors.push({ row: 1, message: 'The sheet is empty.' });
    return result;
  }
  const { map, missing } = mapHeaders(rows[0]);
  if (missing.length) {
    const names: Record<string, string> = { machine: 'Machine', number: 'T-Number', category: 'Category' };
    result.errors.push({ row: 1, message: `Missing column${missing.length > 1 ? 's' : ''}: ${missing.map((k) => names[k]).join(', ')}. Use the template header row.` });
    return result;
  }
  const cell = (r: string[], key: string) => (map[key] === undefined ? '' : (r[map[key]] ?? '').toString().trim());
  const seen = new Map<string, number>(); // "machine|number" -> row

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const rowNo = i + 1;
    if (!r || r.every((c) => !(c ?? '').toString().trim())) continue; // blank line
    const fail = (message: string) => result.errors.push({ row: rowNo, message });

    const machineRaw = cell(r, 'machine');
    if (!machineRaw) { fail('Machine is empty.'); continue; }
    const machine = matchMachine(machineRaw);
    if (!machine) { fail(`Unknown machine "${machineRaw}". Allowed: ${IMPORT_MACHINES.join(', ')}.`); continue; }

    const num = toNumber(cell(r, 'number').replace(/^t/i, ''));
    if (num === null || Number.isNaN(num) || !Number.isInteger(num) || num < 0 || num > 999) {
      fail(`T-Number "${cell(r, 'number')}" must be a whole number (for example 12).`);
      continue;
    }
    const key = `${machine}|${num}`;
    if (seen.has(key)) { fail(`${machine} T${num} is already on row ${seen.get(key)}.`); continue; }

    const pocketRaw = cell(r, 'pocket');
    const pocket = toNumber(pocketRaw);
    if (pocketRaw && (pocket === null || Number.isNaN(pocket) || !Number.isInteger(pocket) || pocket < 0 || pocket > 9999)) {
      fail(`Pocket "${pocketRaw}" must be a whole number or empty.`);
      continue;
    }

    const categoryRaw = cell(r, 'category');
    const category = matchCategory(categoryRaw);
    if (!category) {
      fail(categoryRaw ? `Unknown category "${categoryRaw}". Allowed: ${TOOL_CATEGORIES.join(', ')}.` : 'Category is empty (use "empty" for an empty slot).');
      continue;
    }

    const diameter = toNumber(cell(r, 'diameter'));
    const length = toNumber(cell(r, 'length'));
    if ((diameter !== null && (Number.isNaN(diameter) || diameter < 0 || diameter > 10000)) || (length !== null && (Number.isNaN(length) || length < 0 || length > 10000))) {
      fail('Diameter and Length must be numbers (for example 6.5), or empty.');
      continue;
    }

    const matsRaw = cell(r, 'materials');
    const materials: Tool['materials'] = [];
    let badMaterial = '';
    if (matsRaw) {
      for (const part of matsRaw.split(/[,;/|]+/).map((p) => p.trim()).filter(Boolean)) {
        const m = MATERIALS.find((x) => norm(x) === norm(part));
        if (m) { if (!materials.includes(m)) materials.push(m); } else badMaterial = part;
      }
    }
    if (badMaterial) { fail(`Unknown material "${badMaterial}". Allowed: ${MATERIALS.join(', ')}.`); continue; }

    const isEmpty = category === 'empty';
    const description = cell(r, 'description') || (isEmpty ? 'Empty Slot' : `${category.toUpperCase()} D${diameter ?? '-'}`);
    const tool: Omit<Tool, 'id'> = {
      number: num,
      category: category as Tool['category'],
      description: description.slice(0, 200),
      diameter: isEmpty ? 0 : diameter ?? 0,
      length: isEmpty ? 0 : length ?? 0,
    };
    if (pocket !== null && !Number.isNaN(pocket)) tool.pocket = pocket;
    if (materials.length && !isEmpty) tool.materials = materials;

    seen.set(key, rowNo);
    result.tools.push({ row: rowNo, machine, tool });
    (result.byMachine[machine] ||= []).push(tool);
  }
  if (!result.tools.length && !result.errors.length) result.errors.push({ row: 2, message: 'No tool rows found under the header row.' });
  return result;
}
