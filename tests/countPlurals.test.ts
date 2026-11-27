import { describe, expect, it } from 'vitest';
import i18n from '../src/i18n';
import '../src/i18n/camLocales';

// Counted English texts read right at 1: "1 tool mapped", not "1 tool(s) mapped" or "1 checks to do".
describe('counted texts', () => {
  const en = i18n.getFixedT('en') as unknown as (key: string, opts: object) => string;

  it('use the singular at 1 and the plural otherwise', () => {
    expect(en('history:view.toolsMapped', { count: 1 })).toBe('1 tool mapped');
    expect(en('history:view.toolsMapped', { count: 12 })).toBe('12 tools mapped');
    expect(en('history:view.alerts.archiveDone', { count: 1 })).toBe('Archive downloaded. 1 record older than 30 days was removed from the server.');
    expect(en('data:retention.removed', { count: 1 })).toBe('Archive downloaded, 1 record removed.');
    expect(en('data:log.importingHistory', { count: 1 })).toBe('Importing 1 history record...');
    expect(en('data:log.historyRestored', { count: 1, present: 4 })).toBe('History: 1 new record added, 4 already present.');
    expect(en('preventive:header.checksToDo', { count: 1 })).toBe('1 machine with checks to do');
    expect(en('master:card.due', { count: 1 })).toBe('1 check to do');
    expect(en('master:card.tools', { count: 1 })).toBe('1 tool in inventory');
    expect(en('master:card.failed', { count: 1 })).toBe('1 failed sign-in (7 days)');
    expect(en('master:card.mfa', { count: 1, n: 1 })).toBe('1 of 1 admin uses two-step sign-in');
    expect(en('master:card.mfa', { count: 3, n: 2 })).toBe('2 of 3 admins use two-step sign-in');
    expect(en('remapper:controls.machineOption', { name: 'HAAS-1', count: 1 })).toBe('HAAS-1 (1 tool)');
    expect(en('cam:camAi.opEdit.changed', { count: 1 })).toBe('Changed by hand: 1 operation.');
  });

  it('keep the Turkish texts and their values', () => {
    const tr = i18n.getFixedT('tr') as unknown as (key: string, opts: object) => string;
    expect(tr('master:card.mfa', { count: 3, n: 2 })).toBe('3 yöneticiden 2 tanesi iki adımlı doğrulama kullanıyor');
    expect(tr('data:log.historyRestored', { count: 2, present: 1 })).toBe('Geçmiş: 2 yeni kayıt eklendi, 1 kayıt zaten mevcuttu.');
    expect(tr('history:view.toolsMapped', { count: 1 })).toBe('1 takım eşleştirildi');
  });
});
