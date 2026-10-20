import { MATERIALS, TOOL_CATEGORIES } from '../types';
import { downloadBlob } from './download';
import { CATEGORY_HELP, EXAMPLE_ROWS, IMPORT_MACHINES, TEMPLATE_HEADERS, parseToolRows, type ParseResult } from './toolExcelParse';

/*
 * Excel side of the tool import: builds the downloadable template (with example rows, drop-down
 * lists and an instructions sheet) and reads an uploaded workbook. exceljs is loaded on demand.
 */

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

export async function downloadToolTemplate(): Promise<void> {
  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CNC Process Pro';

  const ws = wb.addWorksheet('Tools', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: TEMPLATE_HEADERS[0], key: 'machine', width: 14 },
    { header: TEMPLATE_HEADERS[1], key: 'number', width: 11 },
    { header: TEMPLATE_HEADERS[2], key: 'pocket', width: 10 },
    { header: TEMPLATE_HEADERS[3], key: 'category', width: 18 },
    { header: TEMPLATE_HEADERS[4], key: 'description', width: 26 },
    { header: TEMPLATE_HEADERS[5], key: 'diameter', width: 14 },
    { header: TEMPLATE_HEADERS[6], key: 'length', width: 13 },
    { header: TEMPLATE_HEADERS[7], key: 'materials', width: 22 },
  ];
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F62D6' } };
  head.alignment = { vertical: 'middle' };
  head.height = 22;
  EXAMPLE_ROWS.forEach((r) => ws.addRow(r));

  // Drop-down lists so nobody has to type a machine or category by hand.
  for (let row = 2; row <= 500; row++) {
    ws.getCell(`A${row}`).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${IMPORT_MACHINES.join(',')}"`], showErrorMessage: true, errorTitle: 'Machine', error: 'Pick a machine from the list.' };
    ws.getCell(`D${row}`).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${TOOL_CATEGORIES.join(',')}"`], showErrorMessage: true, errorTitle: 'Category', error: 'Pick a category from the list.' };
  }
  ws.getCell('J1').value = 'The 5 grey example rows are only a guide: delete or overwrite them. See the "Instructions" sheet.';
  ws.getCell('J1').font = { italic: true, color: { argb: 'FF888888' } };
  for (let r = 2; r <= 1 + EXAMPLE_ROWS.length; r++) ws.getRow(r).font = { color: { argb: 'FF777777' } };

  const info = wb.addWorksheet('Instructions');
  info.columns = [{ width: 20 }, { width: 70 }, { width: 28 }];
  const line = (a?: string, b?: string, c?: string, bold = false) => {
    const row = info.addRow([a ?? '', b ?? '', c ?? '']);
    if (bold) row.font = { bold: true };
    return row;
  };
  line('How to fill the "Tools" sheet', undefined, undefined, true).font = { bold: true, size: 14 };
  line('One row = one tool in one machine. Keep the header row as it is.');
  line();
  line('Column', 'What to write', 'Example', true);
  line('Machine', `The machine name. One of: ${IMPORT_MACHINES.join(', ')}.`, 'HAAS-1');
  line('T-Number', 'The tool number used in the G-code (T12 -> 12). Whole number, unique per machine.', '12');
  line('Pocket', 'Optional. The magazine pocket if it differs from the T-number.', '5');
  line('Category', 'The tool type, picked from the list below.', 'fraise');
  line('Description', 'Optional. A readable name. If empty, one is made from the category and diameter.', 'Fraise D6');
  line('Diameter (mm)', 'Optional. Decimal point or comma both work.', '6.5');
  line('Length (mm)', 'Optional. Cutting length.', '33');
  line('Materials', `Optional. Materials this tool is meant for, separated by commas. Leave empty for a general tool. Allowed: ${MATERIALS.join(', ')}.`, 'ALU, POM');
  line();
  line('Category', 'Meaning', undefined, true);
  for (const c of TOOL_CATEGORIES) line(c, CATEGORY_HELP[c] ?? '');
  line();
  line('When you import', undefined, undefined, true);
  line('Add / update', 'A T-number that already exists on the machine is replaced; all other tools stay.');
  line('Replace', 'Each machine in the file gets exactly the tools in the file (its old tools are removed).');
  line('Check', 'Before anything is saved you see a preview with every problem listed by row number.');

  const buf = await wb.xlsx.writeBuffer();
  downloadBlob('tool-inventory-template.xlsx', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
}

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

export async function readToolWorkbook(file: File): Promise<ParseResult> {
  if (file.size > MAX_IMPORT_BYTES) {
    return { tools: [], byMachine: {}, errors: [{ row: 0, message: 'The file is too large (2 MB max).' }] };
  }
  if (!/\.xlsx$/i.test(file.name)) {
    return { tools: [], byMachine: {}, errors: [{ row: 0, message: 'Please choose an .xlsx Excel file (use the template).' }] };
  }
  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(await file.arrayBuffer());
  } catch {
    return { tools: [], byMachine: {}, errors: [{ row: 0, message: 'This file could not be read as an Excel workbook.' }] };
  }
  const ws = wb.getWorksheet('Tools') ?? wb.worksheets.find((s) => s.name.toLowerCase() !== 'instructions') ?? wb.worksheets[0];
  if (!ws) return { tools: [], byMachine: {}, errors: [{ row: 0, message: 'The workbook has no sheets.' }] };
  const rows: string[][] = [];
  const last = Math.min(ws.rowCount, 2000);
  for (let r = 1; r <= last; r++) {
    const row = ws.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= 8; c++) cells.push(cellText(row.getCell(c).value));
    rows.push(cells);
  }
  return parseToolRows(rows);
}
