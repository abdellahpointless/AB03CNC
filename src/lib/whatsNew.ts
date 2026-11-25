import type { RegionFeatures, RegionId } from '../regions';

/*
 * "What's new": what the latest updates added, newest first. Add an entry with every update people
 * will notice. An entry tied to a feature or a country is only shown where it applies.
 */

export interface Release {
  /** Unique; the newest id seen is remembered to show the dot on the button. */
  id: string;
  date: string;
  feature?: keyof RegionFeatures;
  region?: RegionId;
  en: { title: string; items: string[] };
  tr: { title: string; items: string[] };
}

export const RELEASES: Release[] = [
  {
    id: '2026-11-25-real-vise',
    date: '2026-11-25',
    feature: 'toolpath',
    en: {
      title: 'The shop’s real vise and corner-radius tools in the 3D view',
      items: [
        'The 3D view draws the shop’s Haas vise from its maker’s model: jaws 125 mm long and 45 mm high, the moving jaw and the screw toward the operator.',
        'The part is pushed against a stop at the jaws’ left end (X = 0). Tools are checked against the jaws along their 125 mm from that stop.',
        'Corner-radius end mills (a code like SF_10.00_040_R02, or TORUS / ECKENRADIUS and the radius in the name) are drawn and cut with their rounded bottom edge.',
      ],
    },
    tr: {
      title: 'Atölyenin gerçek mengenesi ve köşe radyuslu takımlar 3B görünümde',
      items: [
        '3B görünüm atölyenin Haas mengenesini üreticisinin modelinden çizer: çeneler 125 mm uzunluğunda ve 45 mm yüksekliğinde, hareketli çene ve mil operatöre doğru.',
        'Parça, çenelerin sol ucundaki bir dayamaya (X = 0) itilir. Takımlar o dayamadan itibaren çenelerin 125 mm’si boyunca denetlenir.',
        'Köşe radyuslu parmak frezeler (SF_10.00_040_R02 gibi bir kod ya da adında TORUS / ECKENRADIUS ve radyus) yuvarlatılmış alt kenarlarıyla çizilir ve keser.',
      ],
    },
  },
  {
    id: '2026-11-24-icons',
    date: '2026-11-24',
    en: {
      title: 'Cleaner icons',
      items: ['A new set of icons across the whole app: one fine outline style, sharper on the shop screens and in print.'],
    },
    tr: {
      title: 'Daha sade simgeler',
      items: ['Uygulamanın tamamında yeni simgeler: tek, ince çizgili bir stil; atölye ekranlarında ve baskıda daha net.'],
    },
  },
  {
    id: '2026-11-23-look',
    date: '2026-11-23',
    en: {
      title: 'New icons and fewer interruptions',
      items: [
        'New icons across the whole app, one consistent set.',
        'Remapper: no banner after importing a program; the FANUC/HAAS buttons above the code convert it.',
        'The weak-password reminder shows once, and long dialogs (the Excel tool import) scroll to their buttons.',
      ],
    },
    tr: {
      title: 'Yeni simgeler ve daha az kesinti',
      items: [
        'Uygulamanın tamamında yeni, tutarlı bir simge seti.',
        'Takım eşleştirici: program içe aktarıldıktan sonra bant çıkmaz; kodun üstündeki FANUC/HAAS düğmeleri dönüştürür.',
        'Zayıf parola hatırlatması bir kez gösterilir; uzun pencereler (Excel takım içe aktarma) düğmelerine kadar kaydırılabilir.',
      ],
    },
  },
  {
    id: '2026-11-23-toolpath',
    date: '2026-11-23',
    feature: 'toolpath',
    en: {
      title: 'Toolpath: STEP models, parallels and measuring in the vise',
      items: [
        'A part’s 3D model can now also be a STEP file (.step or .stp). After importing a program, the 3D model button lights up instead of asking.',
        'The parallels slide out along the vise and the new ones slide in when they change, with a bigger label.',
        'Measure works with the part in the vise; "Part only" in the measure panel takes it out.',
      ],
    },
    tr: {
      title: 'Takım yolu: STEP modeller, kaleler ve mengenede ölçüm',
      items: [
        'Parçanın 3B modeli artık STEP dosyası (.step veya .stp) da olabilir. Program içe aktarıldıktan sonra model istemek yerine 3B model düğmesi yanar.',
        'Kaleler değişirken eskiler mengene boyunca kayarak çıkar, yenileri kayarak girer; etiket daha büyük.',
        'Ölçüm parça mengenedeyken çalışır; ölçüm panelindeki "Yalnızca parça" onu mengeneden çıkarır.',
      ],
    },
  },
  {
    id: '2026-11-03-toolpath-look',
    date: '2026-11-03',
    feature: 'toolpath',
    en: {
      title: 'Toolpath: easier to turn, real materials, collisions in red',
      items: [
        'Turning the part works like CAD software: it turns round the point you grab, never tips sideways, and stops when you let go. Right-drag moves the view; double-click picks a new centre; Top, Front and 3/4 views.',
        'Materials look like the real part: POM black, FH layered wood with its white top, brass, aluminium, steel. Outlines make every edge stand out.',
        'Section: cut the part open across X, Y or Z to look inside holes and walls.',
        'Tools have their real shape (drill tips, chamfers, ball noses, face mills) and the holder its collet nut.',
        'A collision turns the Toolpath button red; it opens right where it happens, with the jaws or the holder in red.',
      ],
    },
    tr: {
      title: 'Takım yolu: daha kolay döndürme, gerçek malzemeler, kırmızı çarpışmalar',
      items: [
        'Parçayı döndürmek CAD yazılımındaki gibi: tuttuğunuz noktanın etrafında döner, yana yatmaz ve bıraktığınızda durur. Sağ sürükleme görünümü kaydırır; çift tıklama yeni bir merkez seçer; Üst, Ön ve 3/4 görünümleri.',
        'Malzemeler gerçek parça gibi görünür: siyah POM, beyaz üst yüzeyli katmanlı FH ahşap, pirinç, alüminyum, çelik. Kenarlar her kenarı öne çıkarır.',
        'Kesit: deliklerin ve duvarların içine bakmak için parçayı X, Y veya Z boyunca kesin.',
        'Takımlar gerçek şekillerinde (matkap uçları, pah takımları, küresel uçlar, tarama kafaları), tutucu da pens somunuyla.',
        'Bir çarpışma Takım yolu düğmesini kırmızı yapar; düğme çarpışmanın olduğu yerde açılır, çeneler veya tutucu kırmızıdır.',
      ],
    },
  },
  {
    id: '2026-11-02-beta-holders',
    date: '2026-11-02',
    feature: 'toolpath',
    en: {
      title: 'Toolpath beta and tool holder check',
      items: [
        'While the toolpath viewer is in beta, an admin picks who may use it (Admin › users › “Toolpath beta”); admins always may.',
        'Each tool’s holder is checked against the part and the vise jaws, from the length the program states for the tool.',
        'A program with a collision cannot be downloaded or copied until it is fixed.',
      ],
    },
    tr: {
      title: 'Takım yolu beta ve tutucu kontrolü',
      items: [
        'Takım yolu görüntüleyici beta aşamasındayken onu kimin kullanabileceğini bir yönetici seçer (Yönetim › kullanıcılar › “Takım yolu beta”); yöneticiler her zaman kullanabilir.',
        'Her takımın tutucusu, programın takım için belirttiği uzunluğa göre parçaya ve mengene çenelerine karşı kontrol edilir.',
        'Çarpışması olan bir program düzeltilene kadar indirilemez veya kopyalanamaz.',
      ],
    },
  },
  {
    id: '2026-11-02-toolpath',
    date: '2026-11-02',
    feature: 'toolpath',
    en: {
      title: 'Toolpath viewer',
      items: [
        'The Toolpath button in the remapper shows the program in 3D: every setup, the turns, the vise and the cales.',
        'The part is cut as the tools move. Play it, or jump to the end or to a setup change.',
        'Weak spots: walls under 0.5 mm stand out in colour.',
        'Measure the part: two faces, two points, a hole’s Ø, or the distance between two holes.',
        'Turn the part freely in every direction.',
      ],
    },
    tr: {
      title: 'Takım yolu görüntüleyici',
      items: [
        'Eşleyicideki Takım yolu düğmesi programı 3B gösterir: her bağlama, çevirmeler, mengene ve paraleller.',
        'Parça, takımlar ilerledikçe işlenir. Oynatın ya da sona veya bir bağlama değişimine atlayın.',
        'Zayıf noktalar: 0,5 mm altındaki duvarlar renkle öne çıkar.',
        'Parçayı ölçün: iki yüzey, iki nokta, bir deliğin çapı veya iki delik arası mesafe.',
        'Parçayı her yöne serbestçe çevirin.',
      ],
    },
  },
  {
    id: '2026-11-02-air',
    date: '2026-11-02',
    region: 'ma',
    en: { title: 'HAAS 2 and HAAS 4: air', items: ['Programs for HAAS 2 and HAAS 4 get M83 (air) wherever they had M08.'] },
    tr: { title: 'HAAS 2 ve HAAS 4: hava', items: ['HAAS 2 ve HAAS 4 programlarında M08 yerine M83 (hava) yazılır.'] },
  },
  {
    id: '2026-11-02-news',
    date: '2026-11-02',
    en: { title: 'What’s new and update notice', items: ['This list of what each update added.', 'A message asks you to refresh the page when a new version is ready.'] },
    tr: { title: 'Yenilikler ve güncelleme bildirimi', items: ['Her güncellemenin getirdiklerinin bu listesi.', 'Yeni bir sürüm hazır olduğunda sayfayı yenilemeniz için bir mesaj çıkar.'] },
  },
  {
    id: '2026-10-29-report',
    date: '2026-10-29',
    feature: 'preventive',
    en: { title: 'Daily printable report', items: ['Pick any day, then print it or save it as a PDF.'] },
    tr: { title: 'Günlük yazdırılabilir rapor', items: ['Herhangi bir günü seçin, yazdırın veya PDF olarak kaydedin.'] },
  },
  {
    id: '2026-10-27-cales',
    date: '2026-10-27',
    feature: 'shiftChecks',
    en: {
      title: 'Cales stock and vise check',
      items: ['One cales stock per size for all machines, with what each machine took.', 'The cales to order (under 4 spare) and a PDF of the order.', 'Vise check on every machine.'],
    },
    tr: {
      title: 'Paralel stoku ve mengene kontrolü',
      items: ['Tüm makineler için ölçü başına tek paralel stoku ve her makinenin aldıkları.', 'Sipariş edilecek paraleller (4 yedekten az) ve siparişin PDF’i.', 'Her makinede mengene kontrolü.'],
    },
  },
  {
    id: '2026-10-26-shifts',
    date: '2026-10-26',
    feature: 'preventive',
    en: {
      title: 'Shift tasks and reports',
      items: ['Start and end of shift tasks, with a PC alert at the end.', 'Preventive reports and periods from the 26th to the 26th.', 'Telegram alerts to several people.'],
    },
    tr: {
      title: 'Vardiya görevleri ve raporlar',
      items: ['Vardiya başı ve sonu görevleri, sonda bilgisayar uyarısı.', 'Önleyici bakım raporları ve ayın 26’sından 26’sına dönemler.', 'Birden fazla kişiye Telegram uyarıları.'],
    },
  },
];

/**
 * The entries for this country, with its switches as they are now; `extra`: the private part's own
 * entries, loaded from its own files for the people it is for. Newest first.
 */
export function releasesFor(region: RegionId, features: RegionFeatures, extra: Release[] = []): Release[] {
  return [...extra, ...RELEASES].filter((r) => (!r.region || r.region === region) && (!r.feature || features[r.feature])).sort((a, b) => b.date.localeCompare(a.date));
}
