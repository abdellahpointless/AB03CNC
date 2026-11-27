import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  catalogFromRows,
  facetOptions,
  matchingTools,
  nextSlot,
  normalizeCatalog,
  normalizeCatalogTool,
  parseCsv,
  readCode,
  toolFromCatalog,
  type CatalogTool,
} from '../src/lib/toolCatalog';

// Made-up codes in the shop's form (the real list is never in the repository).
const HEAD = 'Malzeme (NX menu),LIBRF / takim,Kod malzemesi,Aciklama,Delme takimi,Cap (mm),Agiz,Takim no,"Gagalama adimi (mm) - kutuphane, dogrulanmadi"';
const CSV = [
  HEAD,
  'Aluminum/Ms58-Chiron,SF_07.00_037_000_ALHS,ALHS,7mm Fraeser/37mm lang,,7,3,1,',
  // The same code again, under another NX menu: one tool, both menus' materials.
  'Pcgf/30-Chiron,SF_07.00_037_000_ALHS,ALHS,7mm Fraeser/37mm lang,,7,3,1,',
  'Pom/Peek-Haas,SB_03.30_041_000_KS,KS,3.3mm Bohrer/41mm lang,evet,3.3,2,2,',
  // The Ø column and the description agree with each other, not with the code: the list's Ø is kept, and noted.
  'VA-1.4305-Chiron/Haas,SB_01.20_031_000_VAHS,VAHS,1.3mm Bohrer/31mm lang,evet,1.3,2,3,',
  // The code says 31 mm, the description 52: the code's length is kept, and noted.
  'Aluminum-Haas,AB_04.50_031_G118_AL,AL,4.5mm Bohrer/52mm lang,evet,4.5,2,4,',
  'Aluminum-Haas,AB_05.00_031_G90_AL,AL,NC-Anbohrer D5-90Grad/31mm lang,evet,5,2,5,',
  // A radius mill whose Ø column is 0: the code's Ø.
  'Fh/Rspl-Haas,UDM_11.00_031_R03_FH,FH,Radienfraeser R3 D11/31mm lang,,0,4,6,',
  'Pom/Peek-Haas,RA_09.00_051_000_KS,KS,9 H7 Reibahle/51mm lang,evet,9,6,7,',
  'Pom/Peek-Haas,KS_21.00_031_G45_KS,KS,Kegelsenker D21,evet,21,3,8,',
  'Fh/Rspl-Haas,TF_06.50_026_T1.5_FH,FH,T-Nutfraeser D6.5mm T1.5,,6.5,6,9,',
  // A fine-thread tap: the fourth part is its pitch.
  'Pom/Peek-Haas,GB_07.00_061_001_KS,KS,GEWINDEBOHRER_M7X1,evet,7,1,12,',
  'Pom/Peek-Haas,XX_04.00_030_000_KS,KS,unknown type,,4,2,10,',
  'Pom/Peek-Haas,not a code,KS,,,4,2,11,',
  '',
].join('\r\n');

describe('reading the shop list', () => {
  it('reads quoted cells, CRLF and semicolon files', () => {
    const rows = parseCsv(CSV);
    expect(rows[0]).toHaveLength(9);
    expect(rows[0][8]).toBe('Gagalama adimi (mm) - kutuphane, dogrulanmadi');
    expect(parseCsv('a;b;"c;d"\n1;2,5;3')).toEqual([['a', 'b', 'c;d'], ['1', '2,5', '3']]);
    expect(parseCsv('a,"say ""hi"""\n')).toEqual([['a', 'say "hi"']]);
  });

  it('reads what a code says', () => {
    expect(readCode('UDM_11.00_031_R03_FH')).toEqual({ type: 'UDM', diameter: 11, length: 31, extra: 'R3', angle: null, group: 'FH' });
    expect(readCode('KS_21.00_031_G45_KS')).toMatchObject({ extra: '45°', angle: 45 });
    expect(readCode('TF_06.50_026_T1.5_FH')).toMatchObject({ diameter: 6.5, extra: 'T1.5' });
    expect(readCode('GB_07.00_061_001_KS')).toMatchObject({ type: 'GB', extra: 'P1' });
    expect(readCode('SF_7_37_000_KS')).toBeNull();
  });

  const { tools, notes } = catalogFromRows(parseCsv(CSV));
  const by = (code: string) => tools.find((t) => t.code === code)!;

  it('keeps one tool per code, with every row its materials', () => {
    expect(tools).toHaveLength(10);
    expect(by('SF_07.00_037_000_ALHS')).toEqual({
      code: 'SF_07.00_037_000_ALHS',
      type: 'SF',
      category: 'fraise finition',
      diameter: 7,
      length: 37,
      extra: '',
      flutes: 3,
      // ALHS (owner's legend) and the two NX menus (Ms58 is brass).
      materials: ['ALU', 'BRASS', 'PCGF', 'EPOXY', 'PEEK'],
      description: '7mm Fraeser/37mm lang',
    });
    expect(by('SB_03.30_041_000_KS').materials).toEqual(['PEEK', 'POM']);
    expect(by('UDM_11.00_031_R03_FH').materials).toEqual(['EPOXY', 'FH', 'RESOPAL']);
    expect(by('SB_01.20_031_000_VAHS').materials).toEqual(['INOX']);
  });

  it('files every type (A033): reamer its own, countersink a chamfer tool, AB by its point', () => {
    expect(by('RA_09.00_051_000_KS').category).toBe('alesoir');
    expect(by('KS_21.00_031_G45_KS').category).toBe('chanfrein');
    expect(by('AB_04.50_031_G118_AL').category).toBe('foret');
    expect(by('AB_05.00_031_G90_AL').category).toBe('pointeur');
    expect(by('TF_06.50_026_T1.5_FH')).toMatchObject({ category: 'fraise T', extra: 'T1.5', flutes: 6 });
  });

  it("takes the list's Ø over the code's, the code's when the list has none", () => {
    expect(by('SB_01.20_031_000_VAHS').diameter).toBe(1.3);
    expect(by('UDM_11.00_031_R03_FH').diameter).toBe(11);
  });

  it('notes what the owner may want to fix, and leaves out what is no tool', () => {
    expect(notes.map((n) => [n.row, n.kind, n.a, n.b])).toEqual([
      [5, 'diameter', '1.2', '1.3'],
      [6, 'length', '31', '52'],
      [13, 'unknownType', undefined, undefined],
      [14, 'badCode', undefined, undefined],
    ]);
    expect(tools.some((t) => t.code.startsWith('XX'))).toBe(false);
  });

  it('notes a code whose rows describe it differently, and a tool with no material', () => {
    const r = catalogFromRows(parseCsv([HEAD, 'Aluminum-Haas,SF_07.00_037_000_AL,AL,7mm Fraeser/37mm lang,,7,2,1,', 'Aluminum-Haas,SF_07.00_037_000_AL,AL,7mm Fraeser/37mm lang Diamond,,7,2,1,', 'Chiron,SF_07.00_037_000_QQ,QQ,,,7,2,1,'].join('\n')));
    expect(r.notes.map((n) => [n.row, n.kind])).toEqual([[3, 'description'], [4, 'noMaterial']]);
    expect(r.tools.find((t) => t.code === 'SF_07.00_037_000_AL')!.description).toBe('7mm Fraeser/37mm lang');
  });

  it('finds the code column without its header and reads nothing from a list with no codes', () => {
    expect(catalogFromRows([['x', 'y'], ['SB_03.30_041_000_KS', '3.3']]).tools).toHaveLength(1);
    expect(catalogFromRows([['a', 'b'], ['1', '2']])).toEqual({ tools: [], notes: [] });
    expect(catalogFromRows([])).toEqual({ tools: [], notes: [] });
  });
});

describe('the dropdowns narrow each other', () => {
  const { tools } = catalogFromRows(parseCsv(CSV));

  it('lists what the other picks allow, with how many tools each choice leaves', () => {
    expect(facetOptions(tools, {}, 'type').map((o) => o.value)).toEqual(['SB', 'AB', 'GB', 'RA', 'SF', 'UDM', 'TF', 'KS']);
    const pom = { material: 'POM' };
    expect(facetOptions(tools, pom, 'type')).toEqual([
      { value: 'SB', count: 1 },
      { value: 'GB', count: 1 },
      { value: 'RA', count: 1 },
      { value: 'KS', count: 1 },
    ]);
    // A dropdown still offers its own other values: picking a type does not empty the type list.
    expect(facetOptions(tools, { type: 'SB' }, 'type').map((o) => o.value)).toContain('SF');
    expect(facetOptions(tools, { type: 'SB' }, 'diameter').map((o) => o.value)).toEqual(['1.3', '3.3']);
    expect(matchingTools(tools, { type: 'SB', diameter: '3.3' }).map((t) => t.code)).toEqual(['SB_03.30_041_000_KS']);
    expect(matchingTools(tools, { type: 'SB', diameter: '7' })).toEqual([]);
  });

  it('sorts numbers as numbers and radius, angle and width apart', () => {
    expect(facetOptions(tools, {}, 'diameter').map((o) => o.value)).toEqual(['1.3', '3.3', '4.5', '5', '6.5', '7', '9', '11', '21']);
    expect(facetOptions(tools, {}, 'extra').map((o) => o.value)).toEqual(['R3', '45°', '90°', '118°', 'P1', 'T1.5']);
  });
});

describe('a tool into a machine', () => {
  const t = (number: number, category = 'foret') => ({ number, category }) as never;

  it('goes after the last tool, or to slot 1 (A034)', () => {
    expect(nextSlot([], 41)).toBe(1);
    expect(nextSlot([t(1), t(2), t(7)], 41)).toBe(8);
    // An empty slot is free.
    expect(nextSlot([t(1), t(2, 'empty')], 41)).toBe(2);
    expect(nextSlot([t(3)], null)).toBe(4);
    // A FANUC tool's T may be another number: its slot is its pocket.
    expect(nextSlot([{ number: 250550, pocket: 1, category: 'foret' }], 21)).toBe(2);
  });

  it("takes the first free slot past the machine's last, and none when all are taken", () => {
    expect(nextSlot([t(1), t(3), t(55)], 41)).toBe(2);
    expect(nextSlot([t(1), t(2)], 2)).toBeNull();
  });

  it('becomes an inventory tool with the code as its name and its materials marked', () => {
    const { tools } = catalogFromRows(parseCsv(CSV));
    const sf = tools.find((x) => x.code === 'SF_07.00_037_000_ALHS')!;
    expect(toolFromCatalog(sf, 12, 'id1')).toEqual({
      id: 'id1',
      number: 12,
      category: 'fraise finition',
      description: 'SF_07.00_037_000_ALHS',
      diameter: 7,
      length: 37,
      changed: true,
      materials: ['ALU', 'MS', 'PC GF', 'EPOXYDE', 'PEEK'],
    });
    // A stainless-only tool is marked so (the remapper then never takes it for a general one).
    expect(toolFromCatalog(tools.find((x) => x.code === 'SB_01.20_031_000_VAHS')!, 3, 'id2').materials).toEqual(['INOX']);
  });
});

describe('the server keeps only real entries', () => {
  const ok: CatalogTool = { code: 'SB_03.30_041_000_KS', type: 'SB', category: 'foret', diameter: 3.3, length: 41, extra: '', flutes: 2, materials: ['POM'], description: '3.3mm Bohrer' };

  it("takes the type, length and radius or angle from the code, never the sender's", () => {
    expect(normalizeCatalogTool({ ...ok, type: 'RA', category: 'alesoir', length: 999, extra: 'R9' })).toEqual(ok);
    expect(normalizeCatalogTool({ ...ok, code: ' sb_03.30_041_000_ks ' })?.code).toBe('SB_03.30_041_000_KS');
  });

  it('refuses what is not a tool', () => {
    expect(normalizeCatalogTool({ ...ok, code: 'XX_03.30_041_000_KS' })).toBeNull();
    expect(normalizeCatalogTool({ ...ok, code: "SB_03.30_041_000_KS'); DROP" })).toBeNull();
    expect(normalizeCatalogTool({ ...ok, diameter: 0 })).toBeNull();
    expect(normalizeCatalogTool({ ...ok, diameter: 'x' })).toBeNull();
    expect(normalizeCatalogTool({ ...ok, flutes: 2.5 })).toBeNull();
    expect(normalizeCatalogTool(null)).toBeNull();
  });

  it('drops unknown materials and control characters, and cuts long text', () => {
    const t = normalizeCatalogTool({ ...ok, materials: ['POM', 'GOLD', 'POM'], description: 'a\u0000b'.padEnd(300, 'x'), flutes: '' });
    expect(t?.materials).toEqual(['POM']);
    expect(t?.flutes).toBeNull();
    expect(t?.description.startsWith('a b')).toBe(true);
    expect(t?.description).toHaveLength(120);
  });

  it('refuses a list with a code twice, too many tools, or one bad entry', () => {
    expect(normalizeCatalog([ok])).toEqual([ok]);
    expect(normalizeCatalog([ok, ok])).toBeNull();
    expect(normalizeCatalog([ok, { ...ok, code: 'bad' }])).toBeNull();
    expect(normalizeCatalog(Array.from({ length: 3001 }, () => ok))).toBeNull();
    expect(normalizeCatalog('x')).toBeNull();
  });
});

// The shop's real list, when its path is given (CNC_TOOL_LIST=<file.csv>): counts only, no codes printed.
const LIST = process.env.CNC_TOOL_LIST;
describe.skipIf(!LIST || !existsSync(LIST))("the shop's list", () => {
  it('reads every tool, each with a type and a material, and notes the known slips', () => {
    const { tools, notes } = catalogFromRows(parseCsv(readFileSync(LIST!, 'utf8')));
    expect(tools).toHaveLength(340);
    expect(normalizeCatalog(tools)).toEqual(tools);
    expect(tools.every((t) => t.materials.length > 0 && t.diameter > 0 && t.length > 0)).toBe(true);
    expect(notes.filter((n) => n.kind === 'badCode' || n.kind === 'unknownType')).toEqual([]);
    const count = (k: string) => notes.filter((n) => n.kind === k).length;
    expect([count('diameter'), count('length'), count('description')]).toEqual([3, 4, 2]);
  });
});
