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

/** The entries for this country, with its switches as they are now. */
export function releasesFor(region: RegionId, features: RegionFeatures): Release[] {
  return RELEASES.filter((r) => (!r.region || r.region === region) && (!r.feature || features[r.feature]));
}
