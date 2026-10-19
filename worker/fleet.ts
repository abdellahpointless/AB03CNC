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
