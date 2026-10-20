import type { MachineInfo } from '../regions';

/** Morocco's machines as they were before machines became editable (used until the list is downloaded). */
export const MOROCCO_DEFAULT_MACHINES: MachineInfo[] = [
  { id: 'HAAS-1', name: 'HAAS-1', brand: 'HAAS', model: 'VF-3', image: '/machines/haas-vf3.webp', pockets: 41, hasTools: true, sort: 10 },
  { id: 'HAAS-2', name: 'HAAS-2', brand: 'HAAS', model: 'VF-3', image: '/machines/haas-vf3.webp', pockets: null, hasTools: true, sort: 20 },
  { id: 'HAAS-3', name: 'HAAS-3', brand: 'HAAS', model: 'VF-2', image: '/machines/haas-vf2.webp', pockets: null, hasTools: false, sort: 30 },
  { id: 'HAAS-4', name: 'HAAS-4', brand: 'HAAS', model: 'VF-3', image: '/machines/haas-vf3.webp', pockets: null, hasTools: true, sort: 40 },
  { id: 'HAAS-5', name: 'HAAS-5', brand: 'HAAS', model: 'VF-3', image: '/machines/haas-vf3.webp', pockets: null, hasTools: true, sort: 50 },
  { id: 'FANUC-1', name: 'FANUC-1', brand: 'FANUC', model: 'Robodrill', image: '/machines/fanuc-robodrill.webp', pockets: null, hasTools: true, sort: 60 },
  { id: 'FANUC-2', name: 'FANUC-2', brand: 'FANUC', model: 'Robodrill', image: '/machines/fanuc-robodrill.webp', pockets: null, hasTools: true, sort: 70 },
  { id: 'DMG-1', name: 'DMG-1', brand: 'DMG MORI', model: 'CMX 600 V', image: '/machines/dmg-cmx600v.webp', pockets: null, hasTools: true, sort: 80 },
];

/** Glow colour of a machine card, by brand. */
export function brandAccent(brand: MachineInfo['brand']): string {
  switch (brand) {
    case 'HAAS':
      return '#d32f2f';
    case 'FANUC':
      return '#f5c400';
    case 'DMG MORI':
      return '#9aa4b6';
    default:
      return '#3b6fd4';
  }
}

export function machineName(machines: MachineInfo[], id: string | null | undefined): string {
  if (!id) return '';
  return machines.find((m) => m.id === id)?.name ?? id;
}
