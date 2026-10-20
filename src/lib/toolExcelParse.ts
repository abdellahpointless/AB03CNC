import { MATERIALS, TOOL_CATEGORIES, Tool } from '../types';
import { MACHINE_BRANDS, type MachineBrand } from '../regions';
import trCommon from '../i18n/locales/tr/common';
import i18n from '../i18n';
import { locale } from '../i18n/format';

/*
 * Excel import for the tool inventory: turns the rows of a worksheet into tools, one list per
 * machine, and reports every problem with its row number. Pure functions (no Excel library),
 * so they can be unit tested.
 *
 * Sheet layout (first row = headers, one tool per row):
 *   Machine | T-Number | Pocket | Category | Description | Diameter | Length | Materials | Brand | Model
 * Brand and Model are only needed for a machine that does not exist yet: it is then created.
 * The header texts follow the page language (templateHeaders()); English and Turkish headers are
 * both recognised when reading (HEADER_ALIASES).
 */

/** The template header row in English (the column order of the template). */
export const TEMPLATE_HEADERS = [
  'Machine',
  'T-Number',
  'Pocket',
  'Category',
  'Description',
  'Diameter (mm)',
  'Length (mm)',
  'Materials',
  'Brand (new machines)',
  'Model (new machines)',
] as const;

/** The template header row in the page language (same columns and order as TEMPLATE_HEADERS). */
export function templateHeaders(): string[] {
  return [
    i18n.t('tools:excel.headers.machine'),
    i18n.t('tools:excel.headers.number'),
    i18n.t('tools:excel.headers.pocket'),
    i18n.t('tools:excel.headers.category'),
    i18n.t('tools:excel.headers.description'),
    i18n.t('tools:excel.headers.diameter'),
    i18n.t('tools:excel.headers.length'),
    i18n.t('tools:excel.headers.materials'),
    i18n.t('tools:excel.headers.brand'),
    i18n.t('tools:excel.headers.model'),
  ];
}

/** A category's name in the page language (in English the id itself: "fraise"). */
export function categoryName(category: string): string {
  const key = `common:category.${category}`;
  return i18n.exists(key) ? i18n.t(key as 'common:category.foret') : category;
}

/** The machines of the current country that have a tool inventory. */
export interface ImportMachine {
  id: string;
  name: string;
}

export interface NewMachine {
  name: string;
  brand: MachineBrand;
  model: string;
}

/** Prefix of the byMachine key for a machine that will be created by the import. */
export const NEW_MACHINE_PREFIX = 'new:';

/**
 * What each category is, in the page language (from common:categoryMeaning). Each value is read
 * when it is used, so it always follows the current language.
 */
export const CATEGORY_HELP: Record<string, string> = Object.defineProperties(
  {} as Record<string, string>,
  Object.fromEntries(
    TOOL_CATEGORIES.map((c) => [c, { enumerable: true, get: () => i18n.t(`common:categoryMeaning.${c}`) }]),
  ),
);

/**
 * Example rows for the template and the dialog: the country's own machines when it has some.
 * Categories and descriptions follow the page language (Turkish names are accepted when reading).
 */
export function exampleRows(machines: ImportMachine[]): (string | number)[][] {
  const a = machines[0]?.name;
  const b = machines[1]?.name;
  const m1 = a ?? 'HAAS-1';
  const m2 = b ?? 'FANUC-1';
  const brand1 = a ? '' : 'HAAS';
  const model1 = a ? '' : 'VF-3';
  const brand2 = b ? '' : 'FANUC';
  const model2 = b ? '' : 'Robodrill';
  const c = categoryName;
  return [
    [m1, 1, 1, c('fraise'), i18n.t('tools:excel.examples.endMill'), 6, 33, 'ALU, POM', brand1, model1],
    [m1, 2, 2, c('foret'), i18n.t('tools:excel.examples.drill'), 4.2, 55, '', brand1, model1],
    [m1, 3, 3, c('taraud'), i18n.t('tools:excel.examples.tap'), 5, 0, 'ALU', brand1, model1],
    [m1, 4, '', c('empty'), '', '', '', '', brand1, model1],
    [m2, 1, '', c('tourteau'), i18n.t('tools:excel.examples.faceMill'), 63, 0, '', brand2, model2],
  ];
}

export interface ParsedToolRow {
  row: number;
  /** Existing machine id, or NEW_MACHINE_PREFIX + name for a machine the import will create. */
  machine: string;
  tool: Omit<Tool, 'id'>;
}

export interface ParseResult {
  tools: ParsedToolRow[];
  errors: { row: number; message: string }[];
  /** Tools grouped by machine (existing id, or NEW_MACHINE_PREFIX + name), ready to send. */
  byMachine: Record<string, Omit<Tool, 'id'>[]>;
  /** Machines that do not exist yet and will be created first. */
  newMachines: NewMachine[];
}

/** Lower-case, Turkish letters to ASCII, letters and digits only ("Kılavuz" -> "kilavuz"). */
export const norm = (s: string) =>
  s
    .replace(/[çğıİöşüÇĞÖŞÜ]/g, (c) => ({ ç: 'c', ğ: 'g', ı: 'i', İ: 'i', ö: 'o', ş: 's', ü: 'u', Ç: 'c', Ğ: 'g', Ö: 'o', Ş: 's', Ü: 'u' })[c] ?? c)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');

/** Header names accepted for each column (English, French and Turkish spellings). */
const HEADER_ALIASES: Record<string, string[]> = {
  machine: ['machine', 'machinename', 'machineid', 'machin', 'tezgah', 'tezgahadi', 'makine'],
  number: ['tnumber', 'tnum', 'toolnumber', 'tool', 'number', 'no', 't', 'tnr', 'tnumarasi', 'takimnumarasi', 'takimno'],
  pocket: ['pocket', 'slot', 'pocketnumber', 'magazine', 'cep', 'cepnumarasi', 'magazincebi'],
  category: ['category', 'type', 'categorie', 'toolcategory', 'tooltype', 'kategori', 'tur', 'takimturu'],
  description: ['description', 'name', 'toolname', 'desc', 'designation', 'aciklama', 'ad', 'takimadi'],
  diameter: ['diameter', 'diametermm', 'dia', 'diam', 'd', 'cap', 'capmm'],
  length: ['length', 'lengthmm', 'len', 'l', 'uzunluk', 'uzunlukmm', 'boy', 'boymm'],
  materials: ['materials', 'material', 'matiere', 'matieres', 'malzeme', 'malzemeler'],
  brand: ['brand', 'brandnewmachines', 'make', 'marque', 'marka', 'markayenitezgahlar'],
  model: ['model', 'modelnewmachines', 'modele', 'modelyenitezgahlar'],
};

/** Finds which column holds what, from the header row. */
export function mapHeaders(headerRow: string[]): { map: Record<string, number>; missing: string[] } {
  const map: Record<string, number> = {};
  headerRow.forEach((h, i) => {
    const n = norm(h ?? '');
    if (!n) return;
    for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
      if (map[key] === undefined && aliases.includes(n)) map[key] = i;
    }
  });
  const missing = ['machine', 'number', 'category'].filter((k) => map[k] === undefined);
  return { map, missing };
}

/** "haas 1", "Haas_1", "HAAS-1" -> the machine with that name (or id). */
export function matchMachine(raw: string, machines: ImportMachine[]): ImportMachine | null {
  const n = norm(raw);
  if (!n) return null;
  return machines.find((m) => norm(m.name) === n) ?? machines.find((m) => norm(m.id) === n) ?? null;
}

/** Category id from its id ("fraise"), or its Turkish name ("Parmak freze"). */
export function matchCategory(raw: string): string | null {
  const n = norm(raw);
  if (!n) return null;
  return (
    TOOL_CATEGORIES.find((c) => norm(c) === n) ??
    TOOL_CATEGORIES.find((c) => norm((trCommon.category as Record<string, string>)[c] ?? '') === n) ??
    null
  );
}

export function matchBrand(raw: string): MachineBrand | null {
  const n = norm(raw);
  if (!n) return null;
  if (n === 'dmg' || n === 'dmgmori' || n === 'mori') return 'DMG MORI';
  if (n === 'diger' || n === 'other' || n === 'autre') return 'OTHER';
  return MACHINE_BRANDS.find((b) => norm(b) === n) ?? null;
}

/** Accepts "6.5" and "6,5". Returns NaN for text that is not a number, null for blank. */
function toNumber(raw: string): number | null {
  const t = raw.trim().replace(',', '.');
  if (t === '') return null;
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
}

/**
 * Rows are arrays of cell texts; rows[0] is the header row. `machines` are the current country's
 * machines with a tool inventory.
 */
export function parseToolRows(rows: string[][], machines: ImportMachine[]): ParseResult {
  const result: ParseResult = { tools: [], errors: [], byMachine: {}, newMachines: [] };
  const t = i18n.t.bind(i18n);
  if (!rows.length) {
    result.errors.push({ row: 1, message: t('tools:parse.empty') });
    return result;
  }
  const { map, missing } = mapHeaders(rows[0]);
  if (missing.length) {
    const names: Record<string, string> = { machine: t('tools:columns.machine'), number: t('tools:columns.number'), category: t('tools:columns.category') };
    result.errors.push({ row: 1, message: t('tools:parse.missingColumns', { count: missing.length, list: missing.map((k) => names[k]).join(', ') }) });
    return result;
  }
  const cell = (r: string[], key: string) => (map[key] === undefined ? '' : (r[map[key]] ?? '').toString().trim());
  const seen = new Map<string, number>(); // "machine|number" -> row
  const created = new Map<string, NewMachine>(); // norm(name) -> new machine

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const rowNo = i + 1;
    if (!r || r.every((c) => !(c ?? '').toString().trim())) continue; // blank line
    const fail = (message: string) => result.errors.push({ row: rowNo, message });

    const machineRaw = cell(r, 'machine');
    if (!machineRaw) { fail(t('tools:parse.machineEmpty')); continue; }
    let machineKey: string;
    const existing = matchMachine(machineRaw, machines);
    if (existing) {
      machineKey = existing.id;
    } else {
      // A machine that does not exist yet: allowed when its brand is given (it is created first).
      const key = norm(machineRaw);
      const brandRaw = cell(r, 'brand');
      const brand = matchBrand(brandRaw);
      const known = created.get(key);
      if (!known && !brand) {
        const list = machines.map((m) => m.name).join(', ');
        fail(
          brandRaw
            ? t('tools:parse.unknownBrand', { brand: brandRaw, list: MACHINE_BRANDS.join(', ') })
            : list
              ? t('tools:parse.unknownMachineList', { machine: machineRaw, list })
              : t('tools:parse.unknownMachine', { machine: machineRaw }),
        );
        continue;
      }
      if (known && brand && known.brand !== brand) {
        fail(t('tools:parse.twoBrands', { machine: machineRaw, first: known.brand, second: brand }));
        continue;
      }
      if (!known) {
        if (machineRaw.length > 40) { fail(t('tools:parse.nameTooLong')); continue; }
        const nm: NewMachine = { name: machineRaw, brand: brand!, model: cell(r, 'model').slice(0, 40) };
        created.set(key, nm);
        result.newMachines.push(nm);
      }
      machineKey = NEW_MACHINE_PREFIX + created.get(key)!.name;
    }

    const num = toNumber(cell(r, 'number').replace(/^t/i, ''));
    if (num === null || Number.isNaN(num) || !Number.isInteger(num) || num < 0 || num > 999_999_999) {
      fail(t('tools:parse.badNumber', { value: cell(r, 'number') }));
      continue;
    }
    const dupKey = `${machineKey}|${num}`;
    if (seen.has(dupKey)) { fail(t('tools:parse.duplicate', { machine: machineRaw, number: num, row: seen.get(dupKey) })); continue; }

    const pocketRaw = cell(r, 'pocket');
    const pocket = toNumber(pocketRaw);
    if (pocketRaw && (pocket === null || Number.isNaN(pocket) || !Number.isInteger(pocket) || pocket < 0 || pocket > 9999)) {
      fail(t('tools:parse.badPocket', { value: pocketRaw }));
      continue;
    }

    const categoryRaw = cell(r, 'category');
    const category = matchCategory(categoryRaw);
    if (!category) {
      fail(
        categoryRaw
          ? t('tools:parse.unknownCategory', { value: categoryRaw, list: TOOL_CATEGORIES.map(categoryName).join(', ') })
          : t('tools:parse.categoryEmpty', { empty: categoryName('empty') }),
      );
      continue;
    }

    const diameter = toNumber(cell(r, 'diameter'));
    const length = toNumber(cell(r, 'length'));
    if ((diameter !== null && (Number.isNaN(diameter) || diameter < 0 || diameter > 10000)) || (length !== null && (Number.isNaN(length) || length < 0 || length > 10000))) {
      fail(t('tools:parse.badSize'));
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
    if (badMaterial) { fail(t('tools:parse.unknownMaterial', { value: badMaterial, list: MATERIALS.join(', ') })); continue; }

    const isEmpty = category === 'empty';
    const description =
      cell(r, 'description') || (isEmpty ? t('tools:emptySlot') : `${categoryName(category).toLocaleUpperCase(locale())} D${diameter ?? '-'}`);
    const tool: Omit<Tool, 'id'> = {
      number: num,
      category: category as Tool['category'],
      description: description.slice(0, 200),
      diameter: isEmpty ? 0 : diameter ?? 0,
      length: isEmpty ? 0 : length ?? 0,
    };
    if (pocket !== null && !Number.isNaN(pocket)) tool.pocket = pocket;
    if (materials.length && !isEmpty) tool.materials = materials;

    seen.set(dupKey, rowNo);
    result.tools.push({ row: rowNo, machine: machineKey, tool });
    (result.byMachine[machineKey] ||= []).push(tool);
  }
  if (!result.tools.length && !result.errors.length) result.errors.push({ row: 2, message: t('tools:parse.noRows') });
  return result;
}
