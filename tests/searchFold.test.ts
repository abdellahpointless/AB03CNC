import { describe, expect, it } from 'vitest';
import { searchFold } from '../src/i18n/format';

// The tool search: Turkish capitals find their small letters, whatever the page language.
describe('searchFold', () => {
  const finds = (text: string, query: string) => searchFold(text).includes(searchFold(query));

  it('matches Turkish capitals and small letters', () => {
    expect(finds('Kılavuz M6', 'KILAVUZ')).toBe(true);
    expect(finds('Kılavuz M6', 'kılavuz')).toBe(true);
    expect(finds('Parmak freze finiş', 'FİNİŞ')).toBe(true);
    expect(finds('Parmak freze finiş', 'FINIŞ')).toBe(true);
    expect(finds('ÇAPAK ALMA', 'çapak')).toBe(true);
  });

  it('still matches plain English text and misses what is not there', () => {
    expect(finds('Drill 8.5', 'DRILL')).toBe(true);
    expect(finds('T12', 't12')).toBe(true);
    expect(finds('Kılavuz M6', 'freze')).toBe(false);
  });
});
