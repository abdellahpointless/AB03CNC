import { describe, expect, it } from 'vitest';
import i18n from '../src/i18n';
import { fmtPercent } from '../src/i18n/format';

describe('percent in the page language', () => {
  it('writes 23% in English and %23 in Turkish', async () => {
    expect(fmtPercent(0.234)).toBe('23%');
    await i18n.changeLanguage('tr');
    try {
      expect(fmtPercent(0.234)).toBe('%23');
      expect(fmtPercent(Number.NaN)).toBe('-');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
