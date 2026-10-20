import { regionById, type RegionFeatures, type RegionId } from '../src/regions';

/*
 * Optional parts of a country's app (part tracking, preventive actions). The defaults are in
 * src/regions.ts; a master admin can switch them on or off per country from the dashboard.
 * The choice is stored in the country's own database (settings key "features"). Switching a
 * feature off hides it and closes its API; its data stays in the database.
 */

export const FEATURE_KEYS: (keyof RegionFeatures)[] = ['partTracking', 'preventive'];

export async function readFeatures(db: D1Database, region: RegionId): Promise<RegionFeatures> {
  const features: RegionFeatures = { ...regionById(region)!.features };
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
export async function writeFeatures(db: D1Database, features: RegionFeatures): Promise<void> {
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
