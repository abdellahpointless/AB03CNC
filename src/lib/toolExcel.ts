import { MATERIALS, TOOL_CATEGORIES } from '../types';
import { downloadBlob } from './download';
import { MACHINE_BRANDS } from '../regions';
import i18n from '../i18n';
import { CATEGORY_HELP, categoryName, exampleRows, norm, parseToolRows, templateHeaders, type ImportMachine, type ParseResult } from './toolExcelParse';

/*
 * Excel side of the tool import: builds the downloadable template (with example rows, drop-down
 * lists and an instructions sheet) in the page language and reads an uploaded workbook (English
 * or Turkish template). exceljs is loaded on demand.
 */

/** A sheet name in every language ("Tools", "Takımlar"), so either template can be read back. */
function sheetNames(key: 'sheetTools' | 'sheetInstructions'): string[] {
  return Array.from(new Set((['en', 'tr'] as const).map((lng) => i18n.t(`tools:excel.${key}`, { lng }))));
}

function fileError(message: string): ParseResult {
  return { tools: [], byMachine: {}, newMachines: [], errors: [{ row: 0, message }] };
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const o = v as any;
    if (Array.isArray(o.richText)) return o.richText.map((t: any) => t.text).join('');
    if ('result' in o) return cellText(o.result);
    if ('text' in o) return cellText(o.text);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return '';
  }
  return String(v);
}

export async function downloadToolTemplate(machines: ImportMachine[]): Promise<void> {
  const t = i18n.t.bind(i18n);
  const machineNames = machines.map((m) => m.name);
  const examples = exampleRows(machines);
  const headers = templateHeaders();
  const sheetTools = t('tools:excel.sheetTools');
  const sheetInstructions = t('tools:excel.sheetInstructions');
  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CNC Process Pro';

  const ws = wb.addWorksheet(sheetTools, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: headers[0], key: 'machine', width: 14 },
    { header: headers[1], key: 'number', width: 11 },
    { header: headers[2], key: 'pocket', width: 10 },
    { header: headers[3], key: 'category', width: 18 },
    { header: headers[4], key: 'description', width: 26 },
    { header: headers[5], key: 'diameter', width: 14 },
    { header: headers[6], key: 'length', width: 13 },
    { header: headers[7], key: 'materials', width: 22 },
    { header: headers[8], key: 'brand', width: 20 },
    { header: headers[9], key: 'model', width: 20 },
  ];
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F62D6' } };
  head.alignment = { vertical: 'middle' };
  head.height = 22;
  examples.forEach((r) => ws.addRow(r));

  // Drop-down lists so nobody has to type a machine or category by hand.
  // Categories are listed by their name in the page language (the import accepts both).
  const categoryList = TOOL_CATEGORIES.map(categoryName).join(',');
  for (let row = 2; row <= 500; row++) {
    // Existing machines in a drop-down; a new name is allowed too (its Brand column creates it).
    if (machineNames.length) {
      ws.getCell(`A${row}`).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${machineNames.join(',').replace(/"/g, '')}"`], showErrorMessage: false };
    }
    ws.getCell(`I${row}`).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${MACHINE_BRANDS.join(',')}"`], showErrorMessage: true, errorTitle: t('tools:excel.validation.brandTitle'), error: t('tools:excel.validation.brandError') };
    ws.getCell(`D${row}`).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${categoryList}"`], showErrorMessage: true, errorTitle: t('tools:excel.validation.categoryTitle'), error: t('tools:excel.validation.categoryError') };
  }
  ws.getCell('L1').value = t('tools:excel.note', { sheet: sheetInstructions });
  ws.getCell('L1').font = { italic: true, color: { argb: 'FF888888' } };
  for (let r = 2; r <= 1 + examples.length; r++) ws.getRow(r).font = { color: { argb: 'FF777777' } };

  const info = wb.addWorksheet(sheetInstructions);
  info.columns = [{ width: 20 }, { width: 70 }, { width: 28 }];
  const line = (a?: string, b?: string, c?: string, bold = false) => {
    const row = info.addRow([a ?? '', b ?? '', c ?? '']);
    if (bold) row.font = { bold: true };
    return row;
  };
  const g = (key: string, options?: Record<string, unknown>) => t(`tools:excel.guide.${key}` as 'tools:excel.guide.intro', options as never) as string;
  line(g('title', { sheet: sheetTools }), undefined, undefined, true).font = { bold: true, size: 14 };
  line(g('intro'));
  line();
  line(g('column'), g('whatToWrite'), g('example'), true);
  line(headers[0], machineNames.length ? g('machine', { list: machineNames.join(', ') }) : g('machineNone'), machineNames[0] ?? 'HAAS-1');
  line(headers[1], g('number'), '12');
  line(headers[2], g('pocket'), '5');
  line(headers[3], g('category'), categoryName('fraise'));
  line(headers[4], g('description'), t('tools:excel.examples.endMill'));
  line(headers[5], g('diameter'), t('tools:excel.examples.diameter'));
  line(headers[6], g('length'), '33');
  line(headers[8], g('brand', { list: MACHINE_BRANDS.join(', ') }), 'HAAS');
  line(headers[9], g('model'), 'VF-3');
  line(headers[7], g('materials', { list: MATERIALS.join(', ') }), 'ALU, POM');
  line();
  line(g('categoryHead'), g('meaningHead'), undefined, true);
  for (const c of TOOL_CATEGORIES) line(categoryName(c), CATEGORY_HELP[c] ?? '');
  line();
  line(g('whenImport'), undefined, undefined, true);
  line(g('update'), g('updateText'));
  line(g('replace'), g('replaceText'));
  line(g('check'), g('checkText'));

  const buf = await wb.xlsx.writeBuffer();
  downloadBlob('tool-inventory-template.xlsx', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
}

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

export async function readToolWorkbook(file: File, machines: ImportMachine[]): Promise<ParseResult> {
  if (file.size > MAX_IMPORT_BYTES) {
    return fileError(i18n.t('tools:excel.errors.tooLarge'));
  }
  if (!/\.xlsx$/i.test(file.name)) {
    return fileError(i18n.t('tools:excel.errors.notXlsx'));
  }
  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(await file.arrayBuffer());
  } catch {
    return fileError(i18n.t('tools:excel.errors.unreadable'));
  }
  // The "Tools" sheet of the English or Turkish template, else the first sheet that is not the instructions.
  const instructions = sheetNames('sheetInstructions').map(norm);
  const ws =
    sheetNames('sheetTools').map((n) => wb.getWorksheet(n)).find(Boolean) ??
    wb.worksheets.find((s) => !instructions.includes(norm(s.name))) ??
    wb.worksheets[0];
  if (!ws) return fileError(i18n.t('tools:excel.errors.noSheets'));
  const rows: string[][] = [];
  const last = Math.min(ws.rowCount, 2000);
  for (let r = 1; r <= last; r++) {
    const row = ws.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= 10; c++) cells.push(cellText(row.getCell(c).value));
    rows.push(cells);
  }
  return parseToolRows(rows, machines);
}
