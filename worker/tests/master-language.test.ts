import { describe, expect, it } from 'vitest';
import '../i18n-tr';
import { messageLanguage, translateMessage } from '../i18n';

// The master dashboard in Turkish gets its server messages in Turkish; a country keeps its own language.
const req = (lang?: string) => new Request('https://cnc.test/master/api/alerts', { headers: lang ? { 'X-CNC-Lang': lang } : {} });

describe('master message language', () => {
  it('follows the dashboard on the master hub, English by default', () => {
    expect(messageLanguage('master', req('tr'))).toBe('tr');
    expect(messageLanguage('master', req('en'))).toBe('en');
    expect(messageLanguage('master', req())).toBe('en');
    expect(messageLanguage('master', req('de'))).toBe('en');
  });

  it('keeps each country in its own language, whatever the header says', () => {
    expect(messageLanguage('tr', req('en'))).toBe('tr');
    expect(messageLanguage('ma', req('tr'))).toBe('en');
  });

  it('has Turkish for the master-only messages', () => {
    const tr = (m: string) => translateMessage(m, messageLanguage('master', req('tr')));
    expect(tr('Not signed in')).toBe('Oturumunuz açık değil. Lütfen giriş yapın.');
    expect(tr('Telegram is not set up yet')).toBe('Telegram henüz kurulmadı.');
    expect(tr('This link has expired. Create a new one.')).toBe('Bu bağlantının süresi doldu. Yeni bir bağlantı oluşturun.');
    expect(tr('Add your Telegram username first')).toBe('Önce Telegram kullanıcı adınızı ekleyin.');
    expect(tr('At least one master account must remain')).toBe('En az bir ana yönetici hesabı kalmalıdır.');
    expect(tr('Name is required')).toBe('Ad zorunludur.');
  });
});
