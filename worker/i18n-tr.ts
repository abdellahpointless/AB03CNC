import { registerTurkish } from './i18n';

/*
 * Turkish versions of the server's messages (sent to the Türkiye instance only).
 * - Exact messages: the English text exactly as thrown.
 * - Patterns: messages that contain a number, a name or a field name. Values are kept unchanged.
 * Anything not listed here is sent in English.
 */

/** Field names passed to str() / num() / optStr() / optNum() / intParam(). Unknown names stay in English. */
const FIELD: Record<string, string> = {
  // auth
  Username: 'Kullanıcı adı',
  Password: 'Şifre',
  'Current password': 'Mevcut şifre',
  Challenge: 'Doğrulama oturumu',
  Code: 'Kod',
  // history
  id: 'Kayıt kimliği',
  machine: 'Tezgah',
  size: 'Dosya boyutu',
  olderThanDays: 'Gün sayısı',
  limit: 'Kayıt sınırı',
  offset: 'Başlangıç konumu',
  page: 'Sayfa',
  // machines / preventive maintenance
  Note: 'Not',
  'Problem description': 'Arıza açıklaması',
  Title: 'Başlık',
  // fleet
  'Machine name': 'Tezgah adı',
  Model: 'Model',
  Pockets: 'Cep sayısı',
  Sort: 'Sıra',
  // analytics
  seconds: 'Kazanılan süre (saniye)',
  // tools
  'Tool id': 'Takım kimliği',
  Category: 'Kategori',
  Pocket: 'Cep numarası',
  'Tool number': 'Takım numarası',
  Diameter: 'Çap',
  Length: 'Uzunluk',
  // parts
  'SAP number': 'SAP numarası',
};

const field = (name: string): string => FIELD[name] ?? name;

registerTurkish(
  {
    // ---- index.ts (routing, access, unexpected errors) ----
    'Missing client header': 'İstemci başlığı eksik.',
    'Cross-site request refused': 'Siteler arası istek reddedildi.',
    'This country is not available yet.': 'Bu ülke henüz kullanılamıyor.',
    'Not signed in': 'Oturumunuz açık değil. Lütfen giriş yapın.',
    'Admin access required': 'Bu işlem için yönetici yetkisi gerekiyor.',
    'Invalid URL': 'Geçersiz adres (URL).',
    'Method not allowed': 'Bu istek yöntemine izin verilmiyor.',
    'Not found': 'Bulunamadı.',
    'The free Cloudflare database quota for today is used up. It resets at midnight UTC.':
      'Bugünkü ücretsiz Cloudflare veritabanı kotası doldu. Kota gece yarısı (UTC) sıfırlanır.',
    'Server error. Please try again.': 'Sunucu hatası. Lütfen tekrar deneyin.',

    // ---- http.ts (request body) ----
    'Content-Type must be application/json': 'Content-Type başlığı application/json olmalıdır.',
    'Request body too large': 'İstek çok büyük.',
    'Invalid JSON body': 'İstek içeriği geçerli bir JSON değil.',

    // ---- security.ts (password policy, quotas) ----
    'This password is too common. Choose something harder to guess.':
      'Bu şifre çok yaygın. Lütfen tahmin edilmesi daha zor bir şifre seçin.',
    'The password must not contain the username.': 'Şifre, kullanıcı adını içermemelidir.',
    'Daily upload limit reached. Try again tomorrow.': 'Günlük yükleme sınırına ulaşıldı. Lütfen yarın tekrar deneyin.',
    'Too many searches. Wait a few minutes.': 'Çok fazla arama yapıldı. Lütfen birkaç dakika bekleyin.',

    // ---- auth.ts ----
    'Username can only contain letters, numbers, dots, dashes, underscores and @':
      'Kullanıcı adı yalnızca harf, rakam, nokta, tire, alt çizgi ve @ içerebilir.',
    'Current password is incorrect': 'Mevcut şifre yanlış.',
    'Invalid username or password': 'Kullanıcı adı veya şifre hatalı.',
    'Sign-in expired. Please enter your password again.': 'Giriş süresi doldu. Lütfen şifrenizi yeniden girin.',
    'Wrong code. Check the time on your phone and try again.':
      'Kod yanlış. Telefonunuzdaki saati kontrol edip tekrar deneyin.',
    'The first admin of this country is created by the master admin.':
      'Bu ülkenin ilk yöneticisini ana yönetici oluşturur.',
    'Setup has already been completed. Please sign in.': 'Kurulum zaten tamamlandı. Lütfen giriş yapın.',
    'The new password must be different from the current one.': 'Yeni şifre mevcut şifreden farklı olmalıdır.',
    'Two-step sign-in is already on.': 'İki adımlı doğrulama zaten açık.',
    'Start the setup again.': 'Lütfen kurulumu yeniden başlatın.',
    'The setup changed in another window. Start again.':
      'Kurulum başka bir pencerede değiştirildi. Lütfen yeniden başlayın.',
    'Two-step sign-in is not on.': 'İki adımlı doğrulama açık değil.',
    'Wrong code.': 'Kod yanlış.',
    'This username is reserved. Choose another one.':
      'Bu kullanıcı adı ayrılmış. Lütfen başka bir kullanıcı adı seçin.',

    // ---- routes/users.ts ----
    'Role must be ADMIN or MACHINIST': 'Rol ADMIN (yönetici) veya MACHINIST (operatör) olmalıdır.',
    'User already exists': 'Bu kullanıcı zaten mevcut.',
    'User not found': 'Kullanıcı bulunamadı.',
    'You cannot change your own role': 'Kendi rolünüzü değiştiremezsiniz.',
    'Change your own password from the Security menu': 'Kendi şifrenizi Güvenlik menüsünden değiştirin.',
    'Turn off your own two-step sign-in from the Security menu':
      'Kendi iki adımlı doğrulamanızı Güvenlik menüsünden kapatın.',
    'Nothing to update': 'Güncellenecek bir değişiklik yok.',
    'At least one admin account must remain': 'En az bir yönetici hesabı kalmalıdır.',
    'You cannot delete your own account': 'Kendi hesabınızı silemezsiniz.',

    // ---- routes/master.ts (mostly master hub, which answers in English; kept for completeness) ----
    'This country is not connected yet.': 'Bu ülke henüz bağlanmadı.',
    'Unknown country': 'Bilinmeyen ülke.',
    'This username is already used by a master account.':
      'Bu kullanıcı adı bir ana yönetici hesabı tarafından kullanılıyor.',
    'A master account already exists. Ask a master admin to add more.':
      'Zaten bir ana yönetici hesabı var. Yeni hesap eklemek için bir ana yöneticiye başvurun.',
    'This country could not be read right now.': 'Bu ülkenin verileri şu anda okunamıyor.',

    // ---- routes/admin.ts (backup restore / import) ----
    'users must be an array (max 3 per request)': 'Kullanıcılar bir liste olarak gönderilmelidir (istek başına en fazla 3).',
    'toolbox object required': 'Takım listesi verisi eksik.',
    "mode must be 'update' or 'replace'": "İçe aktarma modu 'update' (güncelle) veya 'replace' (değiştir) olmalıdır.",
    'machines object required': 'Tezgah verisi eksik.',
    'Between 1 and 20 machines per import': 'Her içe aktarmada 1 ile 20 arasında tezgah olmalıdır.',
    'records must be an array (max 200)': 'Kayıtlar bir liste olarak gönderilmelidir (en fazla 200).',
    'id and code are required': 'Kayıt kimliği ve program kodu zorunludur.',
    'entries must be an array (max 300)': 'Parça kayıtları bir liste olarak gönderilmelidir (en fazla 300).',

    // ---- routes/history.ts ----
    'record required': 'Kayıt verisi eksik.',
    'Unsupported code encoding': 'Program dosyasının kodlaması desteklenmiyor.',
    'Program file is too large to store': 'Program dosyası kaydedilemeyecek kadar büyük.',
    'The G-code file for this record is not stored on the server.':
      'Bu kayda ait G-kodu dosyası sunucuda kayıtlı değil.',
    'Stored program file is incomplete.': 'Sunucudaki program dosyası tam değil.',

    // ---- routes/machines.ts (preventive maintenance) ----
    'Frequency must be DAILY, WEEKLY, MONTHLY or QUARTERLY':
      'Sıklık DAILY (günlük), WEEKLY (haftalık), MONTHLY (aylık) veya QUARTERLY (üç aylık) olmalıdır.',
    'Check not found': 'Kontrol maddesi bulunamadı.',
    'Only checklist items can be marked as done': 'Yalnızca kontrol listesi maddeleri yapıldı olarak işaretlenebilir.',
    'Action must be DONE, PROBLEM or RESOLVE': 'İşlem DONE, PROBLEM veya RESOLVE olmalıdır.',
    'Action must be DONE, PROBLEM, STOPS or RESOLVE': 'İşlem DONE, PROBLEM, STOPS veya RESOLVE olmalıdır.',
    'stops must be true or false': 'stops true veya false olmalıdır.',
    'Only an open problem can stop the machine': 'Yalnızca açık bir arıza tezgahı durdurabilir.',
    'Only checklist items can be edited': 'Yalnızca kontrol listesi maddeleri düzenlenebilir.',
    'userIds must be a list of user ids': 'Kullanıcı kimlikleri bir liste olarak gönderilmelidir.',
    'Unknown user in the list': 'Listede bilinmeyen bir kullanıcı var.',

    // ---- routes/fleet.ts ----
    'Unknown machine': 'Bilinmeyen tezgah.',
    'Unknown machine photo': 'Bilinmeyen tezgah fotoğrafı.',
    'The machine name needs at least one letter or digit': 'Tezgah adında en az bir harf veya rakam bulunmalıdır.',

    // ---- routes/tools.ts ----
    'Tool body required': 'Takım verisi eksik.',
    'tools must be a non-empty array (max 100)': 'Takım listesi boş olamaz (en fazla 100 takım).',

    // ---- routes/parts.ts ----
    'SAP number can only contain letters, numbers, hyphens (-), underscores (_), and periods (.).':
      'SAP numarası yalnızca harf, rakam, tire (-), alt çizgi (_) ve nokta (.) içerebilir.',
    'Quantity must be between 1 and 9999.': 'Adet 1 ile 9999 arasında olmalıdır.',
    'Kind must be PRODUCED or MODIFICATION': 'Tür PRODUCED (üretim) veya MODIFICATION (modifikasyon) olmalıdır.',
    'Invalid month': 'Geçersiz ay.',
    'status must be APPROVED or REJECTED': 'Durum APPROVED (onaylandı) veya REJECTED (reddedildi) olmalıdır.',
    'ids must be a list of entry ids (max 200)': 'Kayıt kimlikleri bir liste olarak gönderilmelidir (en fazla 200).',
    'Month filter must look like YYYY-MM': 'Ay filtresi YYYY-AA biçiminde olmalıdır (ör. 2026-10).',
  },
  [
    // ---- security.ts: password length ----
    [/^Password must be at least (\d+) characters for an admin account\.$/, (min) => `Yönetici hesabı için şifre en az ${min} karakter olmalıdır.`],
    [/^Password must be at least (\d+) characters\.$/, (min) => `Şifre en az ${min} karakter olmalıdır.`],

    // ---- auth.ts: lock after failed sign-ins ----
    [/^Too many failed attempts\. Try again in (\d+) minutes?\.$/, (n) => `Çok fazla başarısız deneme yapıldı. Lütfen ${n} dakika sonra tekrar deneyin.`],

    // ---- routes/master.ts ----
    [/^This username is already used in (.+)\. Choose another one\.$/, (country) => `Bu kullanıcı adı zaten kullanılıyor (ülke: ${country}). Lütfen başka bir kullanıcı adı seçin.`],

    // ---- routes/admin.ts (imports, prefixed with the machine) ----
    [/^(.+?): at most (\d+) tools per machine$/, (m, n) => `${m}: bir tezgahta en fazla ${n} takım olabilir.`],
    [/^(.+?): a machine can hold at most (\d+) tools$/, (m, n) => `${m}: bir tezgahta en fazla ${n} takım olabilir.`],
    [/^(.+?): no tools$/, (m) => `${m}: hiç takım yok.`],
    [/^(.+?): T(\d+) appears twice \(entry (\d+)\)$/, (m, t, i) => `${m}: T${t} iki kez geçiyor (${i}. kayıt).`],

    // ---- routes/machines.ts ----
    [/^(.+) is locked for you: you are responsible for other machines\.$/, (m) => `${m} tezgahı sizin için kilitli: siz başka tezgahlardan sorumlusunuz.`],

    // ---- routes/fleet.ts ----
    [/^Brand must be one of: (.+)$/, (list) => `Marka şunlardan biri olmalıdır: ${list}`],
    [/^A machine called "(.*)" already exists$/, (name) => `"${name}" adlı bir tezgah zaten var.`],

    // ---- routes/tools.ts ----
    [/^A machine can hold at most (\d+) tools$/, (n) => `Bir tezgahta en fazla ${n} takım olabilir.`],
    [/^Unknown category "(.*)"$/, (c) => `Bilinmeyen kategori: "${c}".`],
    [/^T-number (.+) is already used by another tool!$/, (n) => `T numarası ${n} zaten başka bir takımda kullanılıyor!`],

    // ---- http.ts: generic validators (keep these last) ----
    [/^(.+) must be a string$/, (f) => `${field(f)} metin olmalıdır.`],
    [/^(.+) is required$/, (f) => `${field(f)} zorunludur.`],
    [/^(.+) is too long \(max (\d+)\)$/, (f, max) => `${field(f)} çok uzun (en fazla ${max} karakter).`],
    [/^(.+) must be a number$/, (f) => `${field(f)} bir sayı olmalıdır.`],
    [/^(.+) must be a whole number$/, (f) => `${field(f)} tam sayı olmalıdır.`],
    [/^(.+) must be between (\S+) and (\S+)$/, (f, min, max) => `${field(f)} ${min} ile ${max} arasında olmalıdır.`],
    [/^(.+) must be an integer$/, (f) => `${field(f)} tam sayı olmalıdır.`],
  ],
);
