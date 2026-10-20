import type { Translation } from '../../types';
import type en from '../en/preventive';

/* Türkçe metinler: önleyici bakım (tezgah alanı, kontrol listeleri, arızalar, sorumlular). */
const preventive: Translation<typeof en> = {
  header: {
    title: 'Önleyici bakım',
    subtitle: 'Durumunu görmek için imleci bir tezgahın üzerine getirin. Kontrol listesini açmak için tezgaha tıklayın.',
    myMachinesTitle: 'Yalnızca sorumlu olduğunuz tezgahları güncelleyebilirsiniz',
    myMachines: 'Sorumluluğunuzda: {{names}}',
    withProblem: '{{count}} arızalı',
    checksToDo: '{{count}} kontrol bekliyor',
    allGood: '{{count}} sorunsuz',
  },
  empty: {
    none: 'Henüz tezgah yok.',
    adminHint: 'Tezgahlarınızı Yönetici → Tezgahlar bölümünden ekleyin.',
    userHint: 'Tezgahları bir yönetici, Yönetici → Tezgahlar bölümünden ekler.',
  },
  status: {
    problems_one: '{{count}} arıza',
    problems_other: '{{count}} arıza',
    checksToDo_one: '{{count}} kontrol bekliyor',
    checksToDo_other: '{{count}} kontrol bekliyor',
    openProblems_one: '{{count}} açık arıza',
    openProblems_other: '{{count}} açık arıza',
    allGood: 'Sorunsuz',
    allUpToDate: 'Tüm kontroller güncel',
  },
  card: {
    ariaLabel: '{{name}}, {{subtitle}}: {{status}}. Kontrol listesini aç',
    lockedTitle: 'Sizin için kilitli',
    you: 'Siz',
    nobodyAssigned: 'Kimse atanmadı',
  },
  pop: {
    whatsWrong: 'Arızalar',
    toDo: 'Yapılacaklar',
    more: '+ {{count}} daha',
    allChecksUpToDate: '{{total}} kontrolün tamamı güncel.',
    lockedForYou: 'Sizin için kilitli.',
    responsible: 'Sorumlu: {{names}}',
    nobodyYet: 'henüz kimse yok',
    noActions: 'Henüz işlem yok',
    clickToView: 'Görüntülemek için tıklayın',
    clickToOpen: 'Açmak için tıklayın',
  },
  events: {
    DONE: 'yapıldı olarak işaretledi',
    PROBLEM: 'arıza bildirdi',
    RESOLVE: 'giderildi olarak işaretledi',
    CHECK_ADDED: 'kontrol ekledi',
    CHECK_EDITED: 'kontrolü düzenledi',
    CHECK_REMOVED: 'kontrolü kaldırdı',
    OWNERS_SET: 'sorumluları belirledi',
    MACHINE_ADDED: 'tezgahı ekledi',
    MACHINE_REMOVED: 'tezgahı kaldırdı',
  },
  sheet: {
    ariaLabel: '{{name}} önleyici bakım',
    reportProblem: 'Arıza bildir',
    viewOnly: 'Yalnızca görüntüleme',
    footer:
      'Herkes kontrolleri yapıldı olarak işaretleyebilir, arıza bildirebilir ve giderebilir. Değişiklikler birkaç saniye içinde tüm bilgisayarlarda görünür.',
  },
  problem: {
    placeholder: 'Sorun ne? ör. soğutma sıvısı pompası ses yapıyor',
    send: 'Gönder',
    openTitle: 'Açık arızalar',
    reportedBy: 'Bildiren: {{user}} · {{time}}',
    fixed: 'Giderildi',
  },
  locked: {
    title: '{{name}} sizin için kilitli.',
    otherMachines: 'Siz başka tezgahlardan sorumlusunuz.',
    owners_one: 'Bu tezgahtan {{names}} sorumlu.',
    owners_other: 'Bu tezgahtan {{names}} sorumlu.',
    canSee: 'Durumunu görebilirsiniz, ancak yalnızca onlar veya bir yönetici güncelleyebilir.',
  },
  owners: {
    title: 'Sorumlular',
    choose: 'Kişileri seç',
    nobodyYet: 'Henüz kimse yok.',
    nobodyYetAdmin: 'Henüz kimse yok. Bu tezgahtan kimin sorumlu olacağını seçin.',
    pickerHelp:
      'Burada seçtiğiniz kişiler yalnızca sorumlu oldukları tezgahları güncelleyebilir. Diğer tüm tezgahlar onlar için kilitlenir.',
    loading: 'Kişiler yükleniyor...',
  },
  check: {
    doneBy: '{{user}} tarafından {{time}} yapıldı',
    notDone: 'Henüz yapılmadı',
    dueAgain: 'yine zamanı geldi',
    done: 'Yapıldı',
    doneTitle: 'Bu kontrolü yaptım',
    reportTitle: 'Bu kontrolle ilgili arıza bildir',
    edit: 'Kontrolü düzenle',
    remove: 'Kontrolü kaldır',
    confirmRemove: '"{{title}}" kontrolü {{machine}} tezgahından kaldırılsın mı?',
  },
  add: {
    title: 'Kontrol ekle (yönetici)',
    placeholder: 'ör. İş mili soğutucu seviyesini kontrol edin',
  },
  history: {
    title: 'Geçmiş',
    empty: 'Henüz kayıt yok.',
  },
  errors: {
    loadMachines: 'Tezgahlar yüklenemedi',
    loadUsers: 'Kullanıcı listesi yüklenemedi',
    describeProblem: 'Arızayı birkaç kelimeyle açıklayın.',
  },
};
export default preventive;
