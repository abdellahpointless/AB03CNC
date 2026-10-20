import { describe, expect, it } from 'vitest';
import { EXAMPLE_ROWS, TEMPLATE_HEADERS, parseToolRows } from '../src/lib/toolExcelParse';
import { readToolWorkbook } from '../src/lib/toolExcel';

const H = [...TEMPLATE_HEADERS] as string[];
const rows = (...r: (string | number)[][]) => [H, ...r.map((x) => x.map(String))];

describe('tool Excel import: parsing', () => {
  it('reads the example rows from the template without errors', () => {
    const res = parseToolRows(rows(...EXAMPLE_ROWS));
    expect(res.errors).toEqual([]);
    expect(Object.keys(res.byMachine).sort()).toEqual(['FANUC-1', 'HAAS-1']);
    expect(res.byMachine['HAAS-1']).toHaveLength(4);
    expect(res.byMachine['HAAS-1'][0]).toMatchObject({ number: 1, pocket: 1, category: 'fraise', description: 'Fraise D6', diameter: 6, length: 33, materials: ['ALU', 'POM'] });
    expect(res.byMachine['HAAS-1'][3]).toMatchObject({ number: 4, category: 'empty', description: 'Empty Slot', diameter: 0 });
  });

  it('is forgiving about spelling, case, decimal commas and "T" prefixes', () => {
    const res = parseToolRows(rows(['haas 2', 'T12', '', 'Fraise Ebauche', '', '6,5', '40,25', 'alu; pom']));
    expect(res.errors).toEqual([]);
    expect(res.byMachine['HAAS-2'][0]).toMatchObject({ number: 12, category: 'fraise ebauche', diameter: 6.5, length: 40.25, materials: ['ALU', 'POM'], description: 'FRAISE EBAUCHE D6.5' });
  });

  it('accepts other column orders and header names', () => {
    const res = parseToolRows([
      ['Category', 'Machine', 'Tool', 'Diameter'],
      ['foret', 'DMG-1', '3', '4.2'],
    ]);
    expect(res.errors).toEqual([]);
    expect(res.byMachine['DMG-1'][0]).toMatchObject({ number: 3, category: 'foret', diameter: 4.2 });
  });

  it('reports every problem with its row number and imports nothing silently', () => {
    const res = parseToolRows(rows(
      ['HAAS-9', 1, '', 'fraise', '', 6, 30, ''],
      ['HAAS-1', 'abc', '', 'fraise', '', 6, 30, ''],
      ['HAAS-1', 2, '', 'banana', '', 6, 30, ''],
      ['HAAS-1', 3, '', 'fraise', '', 'six', 30, ''],
      ['HAAS-1', 4, '', 'fraise', '', 6, 30, 'gold'],
      ['HAAS-1', 5, '', 'fraise', '', 6, 30, ''],
      ['HAAS-1', 5, '', 'foret', '', 4, 30, ''],
      ['', '', '', '', '', '', '', ''],
      ['', 7, '', 'fraise', '', 6, 30, ''],
    ));
    expect(res.errors.map((e) => e.row)).toEqual([2, 3, 4, 5, 6, 8, 10]);
    expect(res.errors[0].message).toMatch(/Unknown machine/);
    expect(res.errors[2].message).toMatch(/Unknown category/);
    expect(res.errors[3].message).toMatch(/Diameter and Length/);
    expect(res.errors[4].message).toMatch(/Unknown material/);
    expect(res.errors[5].message).toMatch(/already on row 7/);
    expect(res.tools).toHaveLength(1);
  });

  it('explains a missing header column and an empty sheet', () => {
    expect(parseToolRows([['Machine', 'Name']]).errors[0].message).toMatch(/Missing columns?: T-Number, Category/);
    expect(parseToolRows([]).errors[0].message).toMatch(/empty/);
    expect(parseToolRows([H]).errors[0].message).toMatch(/No tool rows/);
  });
});

describe('tool Excel import: real .xlsx file', () => {
  it('round-trips a workbook made with exceljs', async () => {
    const ExcelJS = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    const info = wb.addWorksheet('Instructions');
    info.addRow(['ignore me']);
    const ws = wb.addWorksheet('Tools');
    ws.addRow(H);
    ws.addRow(['HAAS-4', 8, 8, 'chanfrein', 'Chanfrein D8', 8, 44, 'ALU']);
    ws.addRow(['FANUC-2', 2, null, 'taraud', null, 5, null, null]);
    const buf = await wb.xlsx.writeBuffer();
    const file = new File([buf], 'tools.xlsx');
    const res = await readToolWorkbook(file);
    expect(res.errors).toEqual([]);
    expect(res.byMachine['HAAS-4'][0]).toMatchObject({ number: 8, category: 'chanfrein', materials: ['ALU'] });
    expect(res.byMachine['FANUC-2'][0]).toMatchObject({ number: 2, category: 'taraud', diameter: 5, length: 0 });
  });

  it('refuses non-xlsx and corrupt files', async () => {
    expect((await readToolWorkbook(new File(['a,b'], 'tools.csv'))).errors[0].message).toMatch(/\.xlsx/);
    expect((await readToolWorkbook(new File(['not a zip'], 'tools.xlsx'))).errors[0].message).toMatch(/could not be read/);
  });
});
