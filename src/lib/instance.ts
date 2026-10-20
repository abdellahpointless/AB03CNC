import { MASTER, REGIONS, regionById, type Language, type RegionId, type RegionInfo } from '../regions';

/*
 * Which part of the app this page is: the country picker (/), a country's app (/ma/, /tr/) or
 * the master dashboard (/master/). Decided once from the URL when the page loads.
 */

export type Instance = { kind: 'hub' } | { kind: 'country'; region: RegionInfo } | { kind: 'master' };

export function instanceFromPath(pathname: string): Instance {
  const first = pathname.split('/').filter(Boolean)[0]?.toLowerCase();
  if (first === 'master') return { kind: 'master' };
  const region = regionById(first);
  return region ? { kind: 'country', region } : { kind: 'hub' };
}

export const INSTANCE: Instance = instanceFromPath(typeof location === 'undefined' ? '/ma/' : location.pathname);

/** The country of this page (Morocco for the picker and outside a browser, e.g. in tests). */
export function currentRegion(): RegionInfo {
  return INSTANCE.kind === 'country' ? INSTANCE.region : REGIONS[0];
}

/** Base address of the API for this page. */
export function apiBase(): string {
  if (INSTANCE.kind === 'master') return '/master/api';
  return `/${currentRegion().id}/api`;
}

/**
 * Browser storage is shared by every page of the site, so each country (and the master) keeps
 * its own keys. Morocco keeps the original names, so nothing saved before is lost.
 */
export function scopedKey(key: string): string {
  if (INSTANCE.kind === 'master') return `master:${key}`;
  const id = currentRegion().id;
  return id === 'ma' ? key : `${id}:${key}`;
}

export function countryPath(id: RegionId): string {
  return `/${id}/`;
}

export const MASTER_PATH = '/master/';
export const HUB_PATH = '/';

const LAST_COUNTRY_KEY = 'cnc-last-country';

export function rememberCountry(id: RegionId): void {
  try {
    localStorage.setItem(LAST_COUNTRY_KEY, id);
  } catch {
    /* storage unavailable */
  }
}

export function lastCountry(): RegionId | null {
  try {
    const v = localStorage.getItem(LAST_COUNTRY_KEY);
    return regionById(v)?.id ?? null;
  } catch {
    return null;
  }
}

/** Language of this page. The master dashboard can switch (saved per browser). */
export function pageLanguage(): Language {
  if (INSTANCE.kind === 'country') return INSTANCE.region.language;
  if (INSTANCE.kind === 'master') {
    try {
      const v = localStorage.getItem('master:cnc-lang');
      if (v === 'en' || v === 'tr') return v;
    } catch {
      /* ignore */
    }
  }
  return 'en';
}

export { MASTER };
