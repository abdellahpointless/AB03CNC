/*
 * The countries the app runs in. Shared by the browser app and the Worker.
 *
 * Each country is a separate instance behind the same link: its own database, accounts,
 * machines, tools and history. The browser picks the country from the first part of the
 * URL (/ma, /tr); the master dashboard lives at /master.
 */

export type RegionId = 'ma' | 'tr';
export type Language = 'en' | 'tr';

export interface RegionInfo {
  id: RegionId;
  /** Country name in English and in the country's own language. */
  name: string;
  nativeName: string;
  language: Language;
  /** BCP 47 locale for dates and numbers. */
  locale: string;
  /** Worker binding of this country's D1 database. */
  dbBinding: 'DB' | 'DB_TR';
  /** Session cookie (each country has its own, so being signed in to one never affects the other). */
  sessionCookie: string;
  /** Cookie name used before the multi-country version (Morocco only). */
  legacyCookie?: string;
  /**
   * Whether the very first admin can be created from the login page. Only the original
   * installation allows it; new countries get their first admin from the master dashboard.
   */
  publicSetup: boolean;
  /** Label shown in authenticator apps so entries of different countries are distinguishable. */
  totpIssuer: string;
}

export const REGIONS: RegionInfo[] = [
  {
    id: 'ma',
    name: 'Morocco',
    nativeName: 'Maroc',
    language: 'en',
    locale: 'en-GB',
    dbBinding: 'DB',
    sessionCookie: '__Host-cnc_sid',
    legacyCookie: 'cnc_sid',
    publicSetup: true,
    totpIssuer: 'CNC Process Pro',
  },
  {
    id: 'tr',
    name: 'Türkiye',
    nativeName: 'Türkiye',
    language: 'tr',
    locale: 'tr-TR',
    dbBinding: 'DB_TR',
    sessionCookie: '__Host-cnc_sid_tr',
    publicSetup: false,
    totpIssuer: 'CNC Process Pro TR',
  },
];

export const MASTER = {
  dbBinding: 'DB_HUB' as const,
  sessionCookie: '__Host-cnc_master',
  totpIssuer: 'CNC Process Pro Master',
};

export function regionById(id: string | null | undefined): RegionInfo | undefined {
  return REGIONS.find((r) => r.id === id);
}

export function isRegionId(id: string | null | undefined): id is RegionId {
  return !!regionById(id);
}

// ---- Machines ------------------------------------------------------------------------

export type MachineBrand = 'HAAS' | 'FANUC' | 'DMG MORI' | 'OTHER';
export const MACHINE_BRANDS: MachineBrand[] = ['HAAS', 'FANUC', 'DMG MORI', 'OTHER'];

/** Photos bundled with the app (public/machines). */
export const MACHINE_IMAGES: { file: string; label: string }[] = [
  { file: '/machines/haas-vf3.webp', label: 'HAAS VF-3' },
  { file: '/machines/haas-vf2.webp', label: 'HAAS VF-2' },
  { file: '/machines/fanuc-robodrill.webp', label: 'FANUC Robodrill' },
  { file: '/machines/dmg-cmx600v.webp', label: 'DMG MORI CMX 600 V' },
];

export interface MachineInfo {
  id: string;
  name: string;
  brand: MachineBrand;
  model: string;
  image: string | null;
  /** Tool changer pockets, when the remapper should enforce a limit. */
  pockets: number | null;
  /** Has a tool inventory and appears in the remapper. */
  hasTools: boolean;
  sort: number;
}

/** The machines the Moroccan installation had before machines became editable. */
export const MOROCCO_ORIGINAL_MACHINE_IDS = ['HAAS-1', 'HAAS-2', 'HAAS-3', 'HAAS-4', 'HAAS-5', 'FANUC-1', 'FANUC-2', 'DMG-1'] as const;

/**
 * The identifier given to the G-code engine. The engine has rules written for specific
 * Moroccan machines (for example "HAAS-1" or "FANUC-2"), and it picks the HAAS/FANUC dialect from
 * the name. Original Moroccan machines keep their exact name, so nothing changes for them. Every
 * other machine (any machine in another country, or a new one) gets a brand-tagged name such as
 * "FANUC~tr~ROBODRILL-1": the dialect still follows the brand, but no rule meant for one
 * particular Moroccan machine can fire for it.
 */
export function engineMachineId(region: RegionId, machine: Pick<MachineInfo, 'id' | 'brand'>): string {
  if (region === 'ma' && (MOROCCO_ORIGINAL_MACHINE_IDS as readonly string[]).includes(machine.id)) return machine.id;
  const brand = machine.brand === 'HAAS' ? 'HAAS' : machine.brand === 'FANUC' ? 'FANUC' : 'OTHER';
  return `${brand}~${region}~${machine.id}`;
}

/** Highest pocket number the remapper offers for a machine. */
export function maxPocketsFor(machine: Pick<MachineInfo, 'brand' | 'pockets'>): number {
  if (machine.pockets) return machine.pockets;
  return machine.brand === 'FANUC' ? 21 : 99;
}
