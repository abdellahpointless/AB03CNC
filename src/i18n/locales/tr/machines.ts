import type { Translation } from '../../types';
import type en from '../en/machines';

/* Türkçe metinler: ülkenin tezgah listesi (yönetici) ve ana yönetici hesabı kartı. */
const machines: Translation<typeof en> = {
  title: 'Tezgahlar',
  subtitle: '{{country}} tezgahları. Takım listesinde, takım eşleştiricide ve önleyici bakımda görünürler.',
  add: 'Tezgah ekle',
  empty: 'Henüz tezgah yok. İlk tezgahı ekleyin.',
  engineNote: 'G-kodu kuralları markaya göre uygulanır: HAAS veya FANUC diyalekti.',
  col: {
    machine: 'Tezgah',
    brandModel: 'Marka / model',
    pockets: 'Cep sayısı',
    tools: 'Takım listesi',
    actions: 'İşlemler',
  },
  yes: 'Var',
  no: 'Yok',
  form: {
    titleNew: 'Yeni tezgah',
    titleEdit: 'Tezgahı düzenle: {{name}}',
    name: 'Ad',
    namePlaceholder: 'ör. HAAS-6 veya Robodrill 3',
    brand: 'Marka',
    model: 'Model',
    modelPlaceholder: 'ör. VF-3',
    photo: 'Fotoğraf',
    noPhoto: 'Genel çizim',
    pockets: 'Takım değiştirici cep sayısı',
    pocketsHint: 'İsteğe bağlı. Takım eşleştirici daha yüksek cep numarası önermez.',
    hasTools: 'Takım listesi var (takım listesi ve takım eşleştirici)',
    save: 'Tezgahı kaydet',
  },
  confirmRemove: '{{name}} kaldırılsın mı? Tüm ekranlardan kaybolur, geçmişi korunur.',
  moveUp: 'Yukarı taşı',
  moveDown: 'Aşağı taşı',
  saved: 'Tezgah kaydedildi.',
  removed: '{{name}} kaldırıldı.',
  master: {
    title: 'Ana yönetici hesabı',
    subtitle:
      'Ana yönetici tüm ülkelerin rakamlarını yan yana görür ve yeni bir ülkenin ilk yöneticisini oluşturur. Ana yöneticiler herhangi bir ülkenin giriş sayfasından giriş yapar.',
    exists: 'Bir ana yönetici hesabı mevcut. Yeni ana yönetici hesapları ana yönetici panelinden eklenir.',
    create: 'Ana yönetici hesabını oluştur',
    username: 'Ana yönetici kullanıcı adı',
    password: 'Ana yönetici şifresi',
    yourPassword: 'Kendi şifreniz (onay için)',
    passwordHint: 'En az 10 karakter. Hiçbir ülkede kullanılmayan bir kullanıcı adı seçin.',
    created: 'Ana yönetici hesabı oluşturuldu. Herhangi bir ülkenin giriş sayfasından bu hesapla giriş yapın.',
    open: 'Ana yönetici panelini aç',
  },
};
export default machines;
