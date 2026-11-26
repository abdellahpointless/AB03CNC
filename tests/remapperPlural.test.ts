import { describe, expect, it } from 'vitest';
import i18n from '../src/i18n';

// The tool resolution window's button: "1 tool still missing", not "1 Tool(s) Still Missing".
describe('remapper: still missing', () => {
  it('says tool or tools by the count', () => {
    const t = i18n.getFixedT('en', 'remapper');
    expect(t('modal.stillMissing', { count: 1 })).toBe('1 tool still missing');
    expect(t('modal.stillMissing', { count: 2 })).toBe('2 tools still missing');
    expect(i18n.getFixedT('tr', 'remapper')('modal.stillMissing', { count: 2 })).toBe('2 takım hâlâ eksik');
  });
});
