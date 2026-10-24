import { describe, expect, it } from 'vitest';
import '../i18n-tr';
import { translateMessage } from '../i18n';
import { passwordProblem } from '../security';

const tr = (msg: string) => translateMessage(msg, 'tr');

describe('Turkish server messages', () => {
  it('translates exact messages', () => {
    expect(tr('Invalid username or password')).toBe('Kullanıcı adı veya şifre hatalı.');
    expect(tr('Not signed in')).toBe('Oturumunuz açık değil. Lütfen giriş yapın.');
    expect(tr('Server error. Please try again.')).toBe('Sunucu hatası. Lütfen tekrar deneyin.');
    expect(tr('Two-step sign-in is already on.')).toBe('İki adımlı doğrulama zaten açık.');
    expect(tr('Unknown machine')).toBe('Bilinmeyen tezgah.');
    expect(tr('Out of stock')).toBe('Stokta yok.');
  });

  it('translates messages with a number or a name, keeping the value', () => {
    expect(tr('Too many failed attempts. Try again in 1 minute.')).toBe(
      'Çok fazla başarısız deneme yapıldı. Lütfen 1 dakika sonra tekrar deneyin.',
    );
    expect(tr('Too many failed attempts. Try again in 15 minutes.')).toBe(
      'Çok fazla başarısız deneme yapıldı. Lütfen 15 dakika sonra tekrar deneyin.',
    );
    expect(tr('A machine called "HAAS VF-2" already exists')).toBe('"HAAS VF-2" adlı bir tezgah zaten var.');
    expect(tr('T-number 12 is already used by another tool!')).toBe('T numarası 12 zaten başka bir takımda kullanılıyor!');
    expect(tr('DMG1: T7 appears twice (entry 3)')).toBe('DMG1: T7 iki kez geçiyor (3. kayıt).');
    expect(tr('HAAS2 is locked for you: you are responsible for other machines.')).toBe(
      'HAAS2 tezgahı sizin için kilitli: siz başka tezgahlardan sorumlusunuz.',
    );
  });

  it('translates the password policy messages', () => {
    expect(tr(passwordProblem('short', 'ali', 'MACHINIST')!)).toBe('Şifre en az 8 karakter olmalıdır.');
    expect(tr(passwordProblem('short', 'ali', 'ADMIN')!)).toBe('Yönetici hesabı için şifre en az 10 karakter olmalıdır.');
    expect(tr(passwordProblem('password123', 'ali', 'MACHINIST')!)).toBe(
      'Bu şifre çok yaygın. Lütfen tahmin edilmesi daha zor bir şifre seçin.',
    );
  });

  it('translates the generic validator messages and their field names', () => {
    expect(tr('Username is required')).toBe('Kullanıcı adı zorunludur.');
    expect(tr('Problem description is too long (max 300)')).toBe('Arıza açıklaması çok uzun (en fazla 300 karakter).');
    expect(tr('Diameter must be a number')).toBe('Çap bir sayı olmalıdır.');
    expect(tr('Pockets must be between 1 and 999')).toBe('Cep sayısı 1 ile 999 arasında olmalıdır.');
    expect(tr('Tool number must be a whole number')).toBe('Takım numarası tam sayı olmalıdır.');
    expect(tr('Title must be a string')).toBe('Başlık metin olmalıdır.');
    expect(tr('page must be an integer')).toBe('Sayfa tam sayı olmalıdır.');
    // A field that is not in the list keeps its English name.
    expect(tr('Widget is required')).toBe('Widget zorunludur.');
  });

  it('prefers the exact entry over a generic pattern', () => {
    expect(tr('Quantity must be between 1 and 9999.')).toBe('Adet 1 ile 9999 arasında olmalıdır.');
  });

  it('leaves unknown messages and English untouched', () => {
    expect(tr('Something nobody translated')).toBe('Something nobody translated');
    for (const msg of ['Invalid username or password', 'Username is required', 'Too many failed attempts. Try again in 5 minutes.']) {
      expect(translateMessage(msg, 'en')).toBe(msg);
      expect(translateMessage(msg, undefined)).toBe(msg);
    }
  });
});
