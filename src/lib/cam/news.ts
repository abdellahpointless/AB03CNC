import type { Release } from '../whatsNew';

/*
 * The private part's "What's new" entries: in its own files only (ROOTS in vite-private-chunks.ts),
 * loaded by the What's new button for the people it is for.
 */
export const CAM_RELEASES: Release[] = [
  {
    id: '2026-11-23-cam-white',
    date: '2026-11-23',
    feature: 'lab',
    en: {
      title: 'CAM AI: the white face and a spacer in the moving jaw',
      items: [
        'A top plate’s white face can be picked on the 3D model: it is never faced, all the stock comes off the other side.',
        'Where a pocket opens onto the face the moving jaw holds, CAM AI puts a 15 mm spacer in that jaw ("15 MM ZWISCHENLAGE IN Y-") and cuts the pocket through, instead of leaving a thin wall to take off by hand.',
        'Programs start with "(3D-MODELL)" and name the admin who made them.',
      ],
    },
    tr: {
      title: 'CAM AI: beyaz yüz ve hareketli çenede ara parça',
      items: [
        'Üst plakanın beyaz yüzü 3B modelde seçilebilir: hiç alınmaz, tüm fazlalık diğer taraftan alınır.',
        'Bir cep hareketli çenenin tuttuğu yüze açılıyorsa CAM AI o çeneye 15 mm ara parça koyar ("15 MM ZWISCHENLAGE IN Y-") ve elle alınacak ince bir duvar bırakmak yerine cebi sonuna kadar keser.',
        'Programlar "(3D-MODELL)" ile başlar ve onları yapan yöneticinin adını taşır.',
      ],
    },
  },
  {
    id: '2026-11-23-cam-rules',
    date: '2026-11-23',
    feature: 'lab',
    en: {
      title: 'CAM AI: held like the shop holds it, finishing where you pick',
      items: [
        'Finishing passes only on the walls you pick on the 3D model (Walls to finish); every other wall is roughed to size. A seal cage’s thin walls are always finished.',
        'The vise holds the part by its long faces, and later clampings grip as deep as their own cuts allow, on shorter parallels.',
        'Tools may go up to 1 mm into a parallel, never at rapid. Through holes between the parallels are drilled out; one over a parallel that cannot be finished from the other side is listed for you.',
      ],
    },
    tr: {
      title: 'CAM AI: atölyenin bağladığı gibi bağlama, son paso seçtiğiniz yerde',
      items: [
        'Son paso yalnızca 3B modelde seçtiğiniz duvarlara yapılır (Son paso yapılacak duvarlar); diğer tüm duvarlar kaba işlemede ölçüsüne alınır. Sızdırmazlık kafesinin ince duvarlarına her zaman son paso yapılır.',
        'Mengene parçayı uzun yüzlerinden tutar; sonraki bağlamalar kendi kesimlerinin izin verdiği kadar derin, daha kısa kalelerle tutar.',
        'Takımlar bir kaleye en fazla 1 mm girebilir, hızlı harekette hiç giremez. Kaleler arasındaki boydan boya delikler tamamen delinir; bir kalenin üstünde kalıp diğer taraftan bitirilemeyen delik size listelenir.',
      ],
    },
  },
  {
    id: '2026-11-23-cam-ai',
    date: '2026-11-23',
    feature: 'lab',
    en: {
      title: 'CAM AI: STEP models and a clearer progress',
      items: [
        'The part’s 3D model can also be a STEP file (.step or .stp).',
        'While it makes the program it shows how far along it is (a percentage that only moves forward) and how long it has been working.',
      ],
    },
    tr: {
      title: 'CAM AI: STEP modeller ve daha anlaşılır ilerleme',
      items: [
        'Parçanın 3B modeli STEP dosyası (.step veya .stp) da olabilir.',
        'Programı yaparken ne kadar ilerlediğini (yalnızca ileri giden bir yüzde) ve ne kadar süredir çalıştığını gösterir.',
      ],
    },
  },
  {
    id: '2026-11-06-cam-ai',
    date: '2026-11-06',
    feature: 'lab',
    en: {
      title: 'CAM AI: the program written from the 3D model (beta)',
      items: [
        'New CAM AI tab: give it the part’s 3D PDF or STL, pick the machine and the material, and it writes the program with that machine’s tools, including the setups, the cales and the M0 texts in the shop’s style.',
        'Rpm, feeds and depths per pass are learned from the shop’s own programs. An admin can set each machine’s limits in Admin › Machines.',
        'Every program is simulated and compared with the model. Download and Send to the remapper unlock only when the part comes out 99 % like the model with no collision. Tools missing from the machine are listed.',
        'Every program CAM AI makes, and every program compared with its model in the toolpath viewer, goes into the learning records (Admin › Backup and data), so CAM AI can learn the shop’s parts.',
      ],
    },
    tr: {
      title: 'CAM AI: 3B modelden yazılan program (beta)',
      items: [
        'Yeni CAM AI sekmesi: parçanın 3B PDF veya STL dosyasını verin, tezgahı ve malzemeyi seçin; program o tezgahın takımlarıyla, bağlamalar, kaleler ve atölye tarzındaki M0 metinleriyle birlikte yazılır.',
        'Devir, ilerleme ve paso derinlikleri atölyenin kendi programlarından öğrenilir. Bir yönetici her tezgahın sınırlarını Yönetim › Tezgahlar’dan belirleyebilir.',
        'Her program simüle edilir ve modelle karşılaştırılır. İndirme ve Takım eşleştiriciye gönderme, ancak parça modele %99 benzediğinde ve çarpışma olmadığında açılır. Tezgahta eksik olan takımlar listelenir.',
        'CAM AI’nin yaptığı her program ve takım yolu görüntüleyicisinde modeliyle karşılaştırılan her program öğrenme kayıtlarına (Yönetim › Yedek ve veri) eklenir; böylece CAM AI atölyenin parçalarını öğrenir.',
      ],
    },
  },
];
