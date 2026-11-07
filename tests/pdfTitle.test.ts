import { describe, expect, it } from 'vitest';
import plateUrl from './models/O1042013.pdf?inline';
import holdingUrl from './models/O2504411.pdf?inline';
import { pdfInfo } from '../src/lib/pdfTitle';
import { partTypeOf } from '../src/lib/cam/partType';

const bytes = (url: string) => Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (c) => c.charCodeAt(0));

describe('part name from the 3D PDF', () => {
  it('reads the title block fields (title, SAP number, drafter), packed objects included', async () => {
    expect(await pdfInfo(bytes(plateUrl))).toEqual({ title: 'Top plate 100201014500', sap: '2330698', author: 'E. Yüksel' });
    expect((await pdfInfo(bytes(holdingUrl))).title).toBe('Holding plate');
  });

  it('a PDF without the fields gives nothing (the operator is asked)', async () => {
    expect(await pdfInfo(new TextEncoder().encode('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n'))).toEqual({ title: null, sap: null, author: null });
  });

  it('the part family from the name', () => {
    expect(partTypeOf('Top plate 100201637205')).toBe('topPlate');
    expect(partTypeOf('Contact pin plate')).toBe('pinPlate');
    expect(partTypeOf('Test pin plate')).toBe('pinPlate');
    expect(partTypeOf('Guidance pin')).toBe('pinPlate');
    expect(partTypeOf('Seal cage ALU')).toBe('sealCage');
    expect(partTypeOf('Contour insert')).toBe('contourInsert');
    expect(partTypeOf('Holding plate')).toBe('subPlate');
    expect(partTypeOf('Bracket')).toBe('other');
    expect(partTypeOf(null)).toBeNull();
  });
});
