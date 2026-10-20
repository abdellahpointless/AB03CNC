import type { RegionFeatures } from '../regions';
import { currentRegion, scopedKey } from './instance';

/*
 * The optional parts of this country's app, as last received from the server (a master admin
 * can switch them on or off). Kept in browser storage so the right tabs show at once on the
 * next start; the defaults of src/regions.ts are used until the first download.
 */

const KEY = scopedKey('cnc-features-v1');

function readCached(): RegionFeatures {
  const features = { ...currentRegion().features };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved && typeof saved === 'object') {
      for (const k of Object.keys(features) as (keyof RegionFeatures)[]) if (typeof saved[k] === 'boolean') features[k] = saved[k];
    }
  } catch {
    /* ignore */
  }
  return features;
}

let current: RegionFeatures = readCached();

export function currentFeatures(): RegionFeatures {
  return current;
}

export function rememberFeatures(features: RegionFeatures): void {
  current = { ...features };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* cache is optional */
  }
}
