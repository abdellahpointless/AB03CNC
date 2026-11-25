import type { Release } from '../whatsNew';

/*
 * The private part's "What's new" entries: in its own files only (ROOTS in vite-private-chunks.ts),
 * loaded by the What's new button for the people it is for.
 */
export const CAM_RELEASES: Release[] = [
  {
    id: '2026-11-25-cam-workspace',
    date: '2026-11-25',
    feature: 'lab',
    en: {
      title: 'CAM AI: a workspace of its own',
      items: [
        'CAM AI opens full screen, without the app’s header and tabs; the arrow at the top left goes back to CNC Process Pro.',
        'One bar at the top: the file, its stock, its checks (click them for every one), its time, Download and Send to the remapper; the rest is under ⋯.',
        'Tools by clamping (OP10, OP20…), one row each; the picked tool’s values and operations on the right. [ and ] fold the two panels away.',
        'Its own simulation: one toolbar over the view, the parallels and the jaw check in its corners, and a timeline with one coloured segment per tool (F fits the view, Space plays).',
      ],
    },
    tr: {
      title: 'CAM AI: kendine ait bir çalışma alanı',
      items: [
        'CAM AI uygulamanın başlığı ve sekmeleri olmadan tam ekran açılır; sol üstteki ok CNC Process Pro’ya döner.',
        'Üstte tek çubuk: dosya, hamı, kontrolleri (hepsi için tıklayın), süresi, İndir ve remapper’a Gönder; gerisi ⋯ altında.',
        'Bağlamaya göre takımlar (OP10, OP20…), her biri bir satır; seçilen takımın değerleri ve işlemleri sağda. [ ve ] iki paneli katlar.',
        'Kendi simülasyonu: görünümün üstünde tek araç çubuğu, köşelerinde paraleller ve çene kontrolü, her takım için renkli bir parçası olan zaman çizelgesi (F görünümü sığdırır, Boşluk oynatır).',
      ],
    },
  },
  {
    id: '2026-11-25-cam-edits',
    date: '2026-11-25',
    feature: 'lab',
    en: {
      title: 'CAM AI: change a made program by hand, see each tool at work',
      items: [
        'Clicking a tool in a made program shows CAM AI’s own simulation at that tool, beside its card.',
        'An operation can be moved (X, Y, Z) or taken deeper by hand: the whole program is checked again. Anything that would hit the vise, a parallel, a holder or the vise floor keeps it locked; a small difference from the model can be accepted with the "I accept this part as it is" tick.',
        'A tool can be changed by hand (Ø and length): its path stays, its speeds follow the new Ø and its feed is never faster. Such a tool is in no machine, so Download stays locked: send the program to the remapper to choose a machine tool for it.',
        'Clamping 1 can have a 15 mm or 50 mm spacer at the stop, pushing the part to the right.',
        'A later clamping shows as it really stands: the stock the clampings before it left, the finished part over it, beside its parallels.',
      ],
    },
    tr: {
      title: 'CAM AI: yapılmış programı elle değiştirin, her takımı çalışırken görün',
      items: [
        'Yapılmış bir programda bir takıma tıklamak, CAM AI’ın kendi simülasyonunu o takımda, kartının yanında gösterir.',
        'Bir işlem elle kaydırılabilir (X, Y, Z) veya daha derine alınabilir: programın tamamı yeniden kontrol edilir. Mengeneye, bir paralele, bir tutucuya veya mengene tabanına çarpacak her şey kilidi korur; modelden küçük bir fark "Bu parçayı olduğu gibi kabul ediyorum" işaretiyle kabul edilebilir.',
        'Bir takım elle değiştirilebilir (Ø ve boy): yolu kalır, devirleri yeni Ø’ye göre ayarlanır ve ilerlemesi asla daha hızlı olmaz. Böyle bir takım hiçbir makinede yoktur, bu yüzden İndir kilitli kalır: ona bir makine takımı seçmek için programı remapper’a gönderin.',
        '1. bağlamada dayamaya 15 mm veya 50 mm ara parça konabilir; parçayı sağa iter.',
        'Sonraki bir bağlama gerçekte durduğu gibi görünür: önceki bağlamaların bıraktığı ham, üzerinde bitmiş parça, paralellerinin yanında.',
      ],
    },
  },
  {
    id: '2026-11-25-cam-beta2',
    date: '2026-11-25',
    feature: 'lab',
    en: {
      title: 'CAM AI Beta 2: the blank side by side, the clamping editor, a clearer simulation',
      items: [
        'The blank is typed side by side (X-, X+, Y-, Y+, Z-, Z+) round a drawing of the part, and shown in 3D before the program is made.',
        'Clamping 1 in the vise: the wheel changes the parallels (Ctrl + wheel zooms), the arrows slide the part and open the jaws; the faces held show green. Later clampings take their parallels from their panel, and open the simulation where they start.',
        'A program whose part comes out bigger than the model (stock left where clampings meet) stays locked and says why.',
        'Tools show their Ø and length; a right click on a path or a tool changes the tool; removed operations stay faded in the view.',
        'Measuring before a program is made; in the simulation: the tool at work highlighted, NX view, weak spots, X-ray section.',
        'Drilled holes are no longer milled again, no chamfer where the model has none, each place finished before the next, STEP files read faster.',
      ],
    },
    tr: {
      title: 'CAM AI Beta 2: taraf taraf ham blok, bağlama düzenleyici, daha açık simülasyon',
      items: [
        'Ham blok taraf taraf girilir (X-, X+, Y-, Y+, Z-, Z+), parçanın çiziminin çevresinde; program yapılmadan 3B olarak gösterilir.',
        'Mengenede 1. bağlama: tekerlek paralelleri değiştirir (Ctrl + tekerlek yakınlaştırır), oklar parçayı kaydırır ve çeneleri açar; tutulan yüzler yeşil görünür. Sonraki bağlamaların paralelleri kendi panellerinden seçilir, simülasyon o bağlamadan açılır.',
        'Parçası modelden büyük çıkan program (bağlamaların buluştuğu yerde kalan ham) kilitli kalır ve nedenini söyler.',
        'Takımlar Ø ve boylarını gösterir; bir yola veya takıma sağ tık takımı değiştirir; kaldırılan işlemler görünümde soluk kalır.',
        'Program yapılmadan ölçme; simülasyonda: çalışan takım vurgulu, NX görünümü, zayıf noktalar, X-ışını kesiti.',
        'Delinen delikler tekrar frezelenmez, modelde pah yoksa pah kırılmaz, her yer bitirilip sonrakine geçilir, STEP dosyaları daha hızlı okunur.',
      ],
    },
  },
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
