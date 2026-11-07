import { describe, expect, it } from 'vitest';
import { parseTemplates } from '../src/lib/cam/templates';
import { alternatives, catalog, cutData, LIBRARY } from '../src/lib/cam/tools';
import type { Tool } from '../src/types';

const row = (title: string, tool: string, number: string, doc: string, step: string, feed: string, rpm: string) =>
  `<tr><td>${title}</td><td>${tool}</td><td>${title}</td><td>${number}</td><td>-0.020</td><td>0.000</td><td>${doc}</td><td>${step}</td><td></td><td>${feed}</td><td>${rpm}</td><td></td></tr>`;

describe('shop templates', () => {
  it('reads tools and operations, skips taps and machine control', () => {
    const html = `<table><tr><td>Title</td><td>Tool</td></tr>
      ${row('PROGRAMM_KOPF', '---', 'MILL-CONTROL', '', '', '0.000', '0 rpm')}
      ${row('TASCHE_8MM', 'SF_08.00_040_000_ALHS', '140800', '5.000', '50 %Flat', '2000 mmpm', '12000 rpm')}
      ${row('KONTUR_8MM', 'SF_08.00_040_000_ALHS', '140800', '5.000', 'Multiple', '2400 mmpm', '12000 rpm')}
      ${row('SCHLICHT_8MM', 'SF_08.00_040_000_ALHS_1', '140800', '3.000', '.1 mm', '1200 mmpm', '12000 rpm')}
      ${row('BOHREN_2.96MM', 'SB_02.96_050_000_ALHS', '250296', 'Model', '', '400 mmpm', '13000 rpm')}
      ${row('GEWINDE_M4', 'GB_04.00_040_000_KS', '440400', 'Model', '', '700 mmpm', '1000 rpm')}</table>`;
    const tools = parseTemplates(html);
    expect(tools.map((t) => t.code)).toEqual(['SB_02.96_050_000_ALHS', 'SF_08.00_040_000_ALHS']);
    const sf = tools[1];
    // The numbered copy (…_ALHS_1) is the same tool.
    expect(sf.ops.map((o) => o.kind)).toEqual(['pocket', 'contour', 'finish']);
    expect(sf.ops[0]).toMatchObject({ ap: 5, ae: { share: 0.5 }, feed: 2000, rpm: 12000 });
    expect(sf.ops[1].ae).toBeNull();
    expect(sf.ops[2].ae).toEqual({ mm: 0.1 });
    expect(tools[0].ops[0]).toMatchObject({ kind: 'drill', ap: null });
  });

  it('the library has the three families, the pin drills and no taps', () => {
    expect(Object.keys(LIBRARY).sort()).toEqual(['ALU', 'FH', 'POM']);
    for (const fam of ['ALU', 'FH', 'POM'] as const) expect(LIBRARY[fam].some((t) => t.type === 'GB')).toBe(false);
    for (const d of [0.98, 1.97, 2.96]) expect(LIBRARY.POM.some((t) => t.type === 'SB' && t.d === d)).toBe(true);
  });
});

describe('tools for a part', () => {
  const machine: Tool[] = [
    { id: 'm1', number: 12, category: 'fraise', description: 'Fraise', diameter: 8, length: 40 },
    { id: 'm2', number: 7, category: 'fraise', description: 'Fraise spéciale', diameter: 10, length: 40 },
    { id: 'm3', number: 3, category: 'taraud', description: 'Taraud', diameter: 4, length: 40 },
  ];

  it('template tools, with the machine number when the machine has it, then special tools; no taps', () => {
    const tools = catalog('ALU', machine);
    const sf8 = tools.find((t) => t.code === 'SF_08.00_040_000_ALHS')!;
    expect(sf8).toMatchObject({ number: 12, inMachine: true });
    expect(tools.find((t) => t.code === 'SF_16.00_049_000_ALHS')!.inMachine).toBe(false);
    expect(tools.find((t) => t.type === 'SF' && t.diameter === 10)).toMatchObject({ number: 7, inMachine: true, template: null });
    expect(tools.some((t) => t.category === 'taraud')).toBe(false);
    expect(() => catalog('INOX', machine)).toThrow();
  });

  it('never gives a template tool a T number the machine uses for another tool', () => {
    // FH templates number the Ø1.5 drill 18; this machine has its Ø5.4 drill in pocket 18.
    const m: Tool[] = [{ id: 'd', number: 18, category: 'foret', description: 'Foret', diameter: 5.4, length: 55 }];
    const tools = catalog('FH', m);
    expect(tools.find((t) => t.type === 'SB' && t.diameter === 5.4 && t.length === 55)).toMatchObject({ number: 18, inMachine: true });
    expect(tools.find((t) => t.code === 'SB_01.50_035_000_FH')!.number).not.toBe(18);
    const numbers = tools.map((t) => t.number);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('caps the rpm at the machine top speed and lowers the feed in proportion', () => {
    const sf8 = catalog('ALU', machine).find((t) => t.code === 'SF_08.00_040_000_ALHS')!;
    const full = cutData(sf8, 'pocket', 'ALU', { maxRpm: 20000, maxFeed: 10000 });
    expect(full).toMatchObject({ s: 12000, f: 2000, ap: 5, ae: 4, from: 'template', template: 'TASCHE_8MM' });
    const capped = cutData(sf8, 'pocket', 'ALU', { maxRpm: 8000, maxFeed: 10000 });
    expect(capped.s).toBe(8000);
    expect(capped.f).toBe(1330);
  });

  it('offers stand-ins for a tool the operator does not have, never a bigger end mill', () => {
    const alt = alternatives('ALU', machine, 'SF_08.00_040_000_ALHS');
    expect(alt.length).toBeGreaterThan(0);
    for (const t of alt) expect(t.type === 'SF' && t.diameter <= 8 && t.length >= 40).toBe(true);
    expect(alt[0].diameter).toBe(8);
  });
});
