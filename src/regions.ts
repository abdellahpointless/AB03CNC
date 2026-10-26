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
  /** Optional parts of the app. Turned off, they are hidden and their API answers "not found". */
  features: RegionFeatures;
  /**
   * Language of the comments in the programs the remapper gives out. CAM programs and tool
   * categories are written in French; 'en' translates those French words to English.
   */
  gcodeComments: 'fr' | 'en';
  /** Shifts and check periods follow this clock (IANA time zone). */
  timeZone: string;
}

export interface RegionFeatures {
  /** "Part without scan" and the admin's "Part review" (part tracking and approval). */
  partTracking: boolean;
  /** "Preventive actions": machine checklists, problem reports and machine responsibility. */
  preventive: boolean;
  /**
   * On top of preventive actions: everyone does their own checks each period, the cales box is
   * checked every shift, people are locked until it is done, and the admin keeps a cales stock.
   */
  shiftChecks: boolean;
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
    timeZone: 'Africa/Casablanca',
    features: { partTracking: true, preventive: true, shiftChecks: true },
    gcodeComments: 'fr',
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
    timeZone: 'Europe/Istanbul',
    // Türkiye uses the G-code remapper and what comes with it (tool inventory, history).
    features: { partTracking: false, preventive: false, shiftChecks: false },
    gcodeComments: 'en',
  },
];

/**
 * Countries announced on the country picker but not open yet: shown with a lock, no link,
 * no database and no translation. To open one, move it to REGIONS (with its database,
 * cookie and language).
 */
export interface UpcomingCountry {
  id: 'tn';
  name: string;
  nativeName: string;
  /** The language it will use, written in that language. */
  languageName: string;
}

export const UPCOMING_COUNTRIES: UpcomingCountry[] = [{ id: 'tn', name: 'Tunisia', nativeName: 'Tunisie', languageName: 'Français' }];

/** The optional features an API path needs, all of them switched on (path without the /xx/api prefix). */
export function featuresOfApiPath(path: string): (keyof RegionFeatures)[] {
  if (/^\/parts(\/|$)/.test(path) || /^\/admin\/import\/parts(\/|$)/.test(path)) return ['partTracking'];
  if (/^\/machines\/(required|cales)(\/|$)/.test(path) || /^\/machines\/[^/]+\/cales\//.test(path)) return ['preventive', 'shiftChecks'];
  if (/^\/machines(\/|$)/.test(path)) return ['preventive'];
  return [];
}

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
