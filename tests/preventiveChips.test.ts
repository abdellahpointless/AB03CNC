import { describe, expect, it } from 'vitest';
import i18n from '../src/i18n';

// The header chips count machines (each filters the floor); '8 checks to do' read as 8 checks next to cards with 11 each.
describe('preventive header chip', () => {
  it('says machines, with a singular', async () => {
    expect(i18n.t('preventive:header.checksToDo', { count: 1 })).toBe('1 machine with checks to do');
    expect(i18n.t('preventive:header.checksToDo', { count: 8 })).toBe('8 machines with checks to do');
    await i18n.changeLanguage('tr');
    try {
      expect(i18n.t('preventive:header.checksToDo', { count: 2 })).toBe('2 tezgahta kontrol var');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
