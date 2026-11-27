import { describe, expect, it } from 'vitest';
import i18n from '../src/i18n';
import { auditDetail } from '../src/lib/auditText';

describe('security log details', () => {
  it('are written in the page language, not as recorded codes and API paths', async () => {
    await i18n.changeLanguage('tr');
    try {
      expect(auditDetail('login', 'password')).toBe('şifre ile');
      expect(auditDetail('user_created', 'h4op (MACHINIST)')).toBe(`h4op (${i18n.t('common:role.MACHINIST')})`);
      expect(auditDetail('user_updated', 'h4tmp: password reset')).toBe('h4tmp: şifre sıfırlandı');
      expect(auditDetail('user_updated', 'ali: role -> ADMIN, two-step sign-in reset')).toBe(
        `ali: rol: ${i18n.t('common:role.ADMIN')}, iki adımlı doğrulama sıfırlandı`,
      );
      expect(auditDetail('features_changed', 'toolpath on, preventive off')).toBe('Takım yolu görüntüleyici açıldı, Önleyici bakım kapatıldı');
      expect(auditDetail('admin_action', 'POST /tr/api/parts/review')).toBe('Parçalar');
      expect(auditDetail('admin_action', 'PUT /tr/api/machines/HAAS-1/owners')).toBe('Önleyici bakım');
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('leaves out a switch the country does not know, and shows anything unknown as recorded', () => {
    expect(auditDetail('features_changed', 'newSwitch on, toolpath off')).toBe('Toolpath viewer switched off');
    expect(auditDetail('features_changed', 'newSwitch on')).toBe('');
    expect(auditDetail('admin_action', 'POST /ma/api/something-new')).toBe('POST /ma/api/something-new');
    expect(auditDetail('login', 'totp')).toBe('with a 2-step code');
    expect(auditDetail('user_deleted', 'karim')).toBe('karim');
    expect(auditDetail('login', null)).toBe('');
  });
});
