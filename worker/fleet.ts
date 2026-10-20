/** The machines on the shop floor that have a preventive-maintenance card. */
export const FLEET_IDS = ['HAAS-1', 'HAAS-2', 'HAAS-3', 'HAAS-4', 'HAAS-5', 'FANUC-1', 'FANUC-2', 'DMG-1'] as const;
export type FleetId = (typeof FLEET_IDS)[number];

export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY';
export const FREQUENCIES: Frequency[] = ['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY'];

/** Starter checklist given to every machine. Admins can edit it per machine in the app. */
export const DEFAULT_CHECKS: { title: string; frequency: Frequency }[] = [
  { title: 'Coolant level checked and topped up', frequency: 'DAILY' },
  { title: 'Lubrication oil level OK', frequency: 'DAILY' },
  { title: 'Air pressure in the green zone, no air leaks', frequency: 'DAILY' },
  { title: 'Chips cleaned from table, enclosure and way covers', frequency: 'DAILY' },
  { title: 'Spindle taper and tool holders cleaned', frequency: 'WEEKLY' },
  { title: 'Chip conveyor / auger cleaned', frequency: 'WEEKLY' },
  { title: 'Coolant concentration checked (refractometer)', frequency: 'WEEKLY' },
  { title: 'Door window, lights and door safety switch OK', frequency: 'WEEKLY' },
  { title: 'Coolant filters and tank screens cleaned', frequency: 'MONTHLY' },
  { title: 'Air filter drained, electrical cabinet fans clean', frequency: 'MONTHLY' },
  { title: 'Coolant tank emptied and cleaned', frequency: 'QUARTERLY' },
];

/** The same starter checklist in Turkish, used for machines created in the Turkish instance. */
export const DEFAULT_CHECKS_TR: { title: string; frequency: Frequency }[] = [
  { title: 'Soğutma sıvısı (bor yağı) seviyesi kontrol edildi, gerekirse tamamlandı', frequency: 'DAILY' },
  { title: 'Yağlama yağı seviyesi uygun', frequency: 'DAILY' },
  { title: 'Hava basıncı yeşil bölgede, hava kaçağı yok', frequency: 'DAILY' },
  { title: 'Tabla, kabin ve kızak kapaklarındaki talaşlar temizlendi', frequency: 'DAILY' },
  { title: 'İş mili konikliği ve takım tutucular temizlendi', frequency: 'WEEKLY' },
  { title: 'Talaş konveyörü / helezonu temizlendi', frequency: 'WEEKLY' },
  { title: 'Soğutma sıvısı konsantrasyonu ölçüldü (refraktometre)', frequency: 'WEEKLY' },
  { title: 'Kapı camı, aydınlatma ve kapı emniyet şalteri sağlam', frequency: 'WEEKLY' },
  { title: 'Soğutma sıvısı filtreleri ve tank süzgeçleri temizlendi', frequency: 'MONTHLY' },
  { title: 'Hava filtresi suyu boşaltıldı, elektrik panosu fanları temiz', frequency: 'MONTHLY' },
  { title: 'Soğutma sıvısı tankı boşaltıldı ve temizlendi', frequency: 'QUARTERLY' },
];
