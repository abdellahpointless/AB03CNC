import { describe, expect, it } from 'vitest';
import { TEMPLATE_HEADERS, exampleRows, mapHeaders, parseToolRows as parse, NEW_MACHINE_PREFIX, templateHeaders } from '../src/lib/toolExcelParse';
import i18n from '../src/i18n';
import { MOROCCO_DEFAULT_MACHINES } from '../src/lib/machines';

const MA = MOROCCO_DEFAULT_MACHINES.filter((m) => m.hasTools);
const parseToolRows = (rows: string[][]) => parse(rows, MA);
const EXAMPLE_ROWS = exampleRows(MA);
import { readToolWorkbook } from '../src/lib/toolExcel';

const H = [...TEMPLATE_HEADERS] as string[];
const rows = (...r: (string | number)[][]) => [H, ...r.map((x) => x.map(String))];

describe('tool Excel import: parsing', () => {
  it('reads the example rows from the template without errors', () => {
    const res = parseToolRows(rows(...EXAMPLE_ROWS));
    expect(res.errors).toEqual([]);
    expect(Object.keys(res.byMachine).sort()).toEqual(['HAAS-1', 'HAAS-2']);
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
    expect(res.errors[0].message).toMatch(/Unknown machine "HAAS-9".*fill in its Brand/);
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
    const res = await readToolWorkbook(file, MA);
    expect(res.errors).toEqual([]);
    expect(res.byMachine['HAAS-4'][0]).toMatchObject({ number: 8, category: 'chanfrein', materials: ['ALU'] });
    expect(res.byMachine['FANUC-2'][0]).toMatchObject({ number: 2, category: 'taraud', diameter: 5, length: 0 });
  });

  it('refuses non-xlsx and corrupt files', async () => {
    expect((await readToolWorkbook(new File(['a,b'], 'tools.csv'), MA)).errors[0].message).toMatch(/\.xlsx/);
    expect((await readToolWorkbook(new File(['not a zip'], 'tools.xlsx'), MA)).errors[0].message).toMatch(/could not be read/);
  });
});

describe('tool Excel import: new machines and other countries', () => {
  it('creates a machine that does not exist when its brand is given', () => {
    const res = parse(
      [
        [...TEMPLATE_HEADERS],
        ['Robodrill Ş-1', '250550', '4', 'pointeur', '', '', '', '', 'FANUC', 'α-D21MiB5'],
        ['robodrill ş-1', '161600', '', 'Kaba parmak freze', '', '16', '', '', '', ''],
        ['HAAS-1', '5', '', 'Kılavuz', '', '6', '', '', '', ''],
      ],
      [],
    );
    expect(res.errors.map((e) => e.message)).toEqual(['Unknown machine "HAAS-1". To create a new machine, fill in its Brand column.']);
    expect(res.newMachines).toEqual([{ name: 'Robodrill Ş-1', brand: 'FANUC', model: 'α-D21MiB5' }]);
    const list = res.byMachine[NEW_MACHINE_PREFIX + 'Robodrill Ş-1'];
    expect(list.map((t) => [t.number, t.category])).toEqual([[250550, 'pointeur'], [161600, 'fraise ebauche']]);
  });

  it('accepts Turkish category names and Turkish column headers', () => {
    const res = parse(
      [
        ['Tezgah', 'T Numarası', 'Kategori', 'Çap (mm)', 'Malzemeler'],
        ['TR-1', '3', 'Matkap', '4,2', 'ALU'],
      ],
      [{ id: 'TR-1', name: 'TR-1' }],
    );
    expect(res.errors).toEqual([]);
    expect(res.byMachine['TR-1'][0]).toMatchObject({ number: 3, category: 'foret', diameter: 4.2, materials: ['ALU'] });
  });

  it('refuses two brands for one new machine and unknown brands', () => {
    const res = parse(
      [
        [...TEMPLATE_HEADERS],
        ['NEW-1', '1', '', 'foret', '', '', '', '', 'HAAS', ''],
        ['NEW-1', '2', '', 'foret', '', '', '', '', 'FANUC', ''],
        ['NEW-2', '1', '', 'foret', '', '', '', '', 'Mazak', ''],
      ],
      [],
    );
    expect(res.errors.map((e) => e.row)).toEqual([3, 4]);
    expect(res.errors[1].message).toMatch(/Unknown brand "Mazak"/);
  });
});

describe('tool Excel import: page language', () => {
  it('uses the English header row in English', () => {
    expect(templateHeaders()).toEqual([...TEMPLATE_HEADERS]);
  });

  it('reads back the Turkish template header row and Turkish example rows', async () => {
    await i18n.changeLanguage('tr');
    try {
      const trHeaders = templateHeaders();
      expect(trHeaders[0]).toBe('Tezgah');
      const { map, missing } = mapHeaders(trHeaders);
      expect(missing).toEqual([]);
      expect(Object.keys(map).sort()).toEqual(['brand', 'category', 'description', 'diameter', 'length', 'machine', 'materials', 'model', 'number', 'pocket']);
      const res = parse([trHeaders, ...exampleRows(MA).map((r) => r.map(String))], MA);
      expect(res.errors).toEqual([]);
      expect(res.byMachine['HAAS-1'].map((t) => t.category)).toEqual(['fraise', 'foret', 'taraud', 'empty']);
      expect(res.byMachine['HAAS-1'][0]).toMatchObject({ number: 1, description: 'Parmak freze D6', diameter: 6, materials: ['ALU', 'POM'] });
      expect(res.byMachine['HAAS-2'][0]).toMatchObject({ number: 1, category: 'tourteau', diameter: 63 });
      // New machines through the Turkish Brand column.
      const created = parse([trHeaders, ['YENİ-1', '1', '', 'Matkap', '', '5', '', '', 'FANUC', 'α-D21']], []);
      expect(created.errors).toEqual([]);
      expect(created.newMachines).toEqual([{ name: 'YENİ-1', brand: 'FANUC', model: 'α-D21' }]);
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
