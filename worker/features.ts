import { regionById, type RegionFeatures, type RegionId } from '../src/regions';
import type { AuthedUser } from './context';

/*
 * Optional parts of a country's app (part tracking, preventive actions, shift checks, toolpath viewer,
 * tool database, CAM AI). The defaults are in src/regions.ts (CAM AI's here only: the public page must not name it);
 * a master admin can switch them on or off per country from the dashboard.
 * The choice is stored in the country's own database (settings key "features"). Switching a
 * feature off hides it and closes its API; its data stays in the database.
 */

/** The switches as stored, CAM AI's with them. */
export type StoredFeatures = Omit<RegionFeatures, 'lab'> & { camAi: boolean };
/** The countries whose admins may use CAM AI (owner's rule), with its default there. */
const CAM_AI: Partial<Record<RegionId, boolean>> = { ma: true };

export const FEATURE_KEYS: (keyof StoredFeatures)[] = ['partTracking', 'preventive', 'shiftChecks', 'toolpath', 'toolCatalog', 'camAi'];

/** CAM AI only for the admins of a country it is for, where its switch is on (and the master dashboard). */
export function camAllowed(region: RegionId | undefined, user: Pick<AuthedUser, 'role'>, f: StoredFeatures): boolean {
  return !!region && region in CAM_AI && user.role === 'ADMIN' && f.camAi;
}

/** The switches as this person's browser gets them: CAM AI only for those who may use it, under a neutral name. */
export function featuresFor(region: RegionId, user: Pick<AuthedUser, 'role'>, f: StoredFeatures): RegionFeatures {
  const { camAi: _camAi, ...rest } = f;
  return camAllowed(region, user, f) ? { ...rest, lab: true } : rest;
}

export async function readFeatures(db: D1Database, region: RegionId): Promise<StoredFeatures> {
  const { lab: _lab, ...defaults } = regionById(region)!.features;
  const features: StoredFeatures = { ...defaults, camAi: CAM_AI[region] ?? false };
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'features'").first<{ value: string }>();
  if (row) {
    try {
      const saved = JSON.parse(row.value) as Partial<Record<string, unknown>>;
      for (const k of FEATURE_KEYS) if (typeof saved[k] === 'boolean') features[k] = saved[k] as boolean;
    } catch {
      /* a damaged value falls back to the defaults */
    }
  }
  return features;
}

/** Saves the switches and tells every open PC of the country (sync "settings" version). */
export async function writeFeatures(db: D1Database, features: StoredFeatures): Promise<void> {
  const value = JSON.stringify(Object.fromEntries(FEATURE_KEYS.map((k) => [k, features[k]])));
  await db.batch([
    db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES ('features', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(value, Date.now()),
    db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'v_settings'"),
  ]);
}
