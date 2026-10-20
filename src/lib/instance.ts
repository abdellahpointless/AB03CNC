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

/** Address of the country picker when someone asks to change country (it never redirects). */
export const CHOOSE_COUNTRY_PATH = '/?choose';

export function wantsCountryPicker(search: string = typeof location === 'undefined' ? '' : location.search): boolean {
  return new URLSearchParams(search).has('choose');
}

/**
 * The country this browser belongs to. People pick it once on the country picker; after that
 * the site's address always opens that country (also after signing out) until someone asks to
 * change country. Browsers that used the app before there were several countries already have
 * Morocco's saved data (its keys have no prefix), so they go straight to Morocco.
 */
export function homeCountry(): RegionId | null {
  const last = lastCountry();
  if (last) return last;
  try {
    if (localStorage.getItem('cnc-toolbox-cache-v1') !== null || localStorage.getItem('cnc-session-user') !== null) return 'ma';
  } catch {
    /* storage unavailable */
  }
  return null;
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
