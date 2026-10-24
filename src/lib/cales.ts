/*
 * The cales (parallels) box that comes with each machine: two aluminium cales per height, always
 * used together as a pair. The box holds one pair per slot, tallest on the left.
 *
 * Preview: the state lives in this browser only (localStorage). The rules (who checks, how often,
 * what it means for the machine, history, alerts) are decided later, then it moves to the server.
 */

/** Heights in mm, in slot order (left → right as the box is seen from the front). */
export const CALE_HEIGHTS = [43, 42, 41, 40, 38, 35, 33, 30, 28, 25, 22, 20, 15, 8] as const;
export type CaleHeight = (typeof CALE_HEIGHTS)[number];

export type CaleStatus = 'present' | 'missing' | 'damaged';

export interface CalesRecord {
  /** Status of each pair, by height. */
  status: Record<number, CaleStatus>;
  /** When someone last confirmed "all the cales are there" (ms), or null. */
  verifiedAt: number | null;
}

export const emptyCales = (): CalesRecord => ({
  status: Object.fromEntries(CALE_HEIGHTS.map((h) => [h, 'present'])) as Record<number, CaleStatus>,
  verifiedAt: null,
});

export interface CalesSummary {
  missing: number[];
  damaged: number[];
  /** Every pair is there and in good shape, and someone confirmed it. */
  allGood: boolean;
  verifiedAt: number | null;
}

export function calesSummary(r: CalesRecord): CalesSummary {
  const missing = CALE_HEIGHTS.filter((h) => r.status[h] === 'missing');
  const damaged = CALE_HEIGHTS.filter((h) => r.status[h] === 'damaged');
  return { missing, damaged, allGood: !missing.length && !damaged.length && r.verifiedAt !== null, verifiedAt: r.verifiedAt };
}

/** "I found all the cales": missing pairs are back; damaged ones stay damaged (they are there, but hurt). */
export function foundAll(r: CalesRecord, now = Date.now()): CalesRecord {
  const status = { ...r.status };
  for (const h of CALE_HEIGHTS) if (status[h] === 'missing') status[h] = 'present';
  return { status, verifiedAt: now };
}

export function setPair(r: CalesRecord, h: number, s: CaleStatus): CalesRecord {
  return { ...r, status: { ...r.status, [h]: s } };
}

// ---- Preview storage (this browser only) ----

const key = (machineId: string) => `cnc-cales-preview:${machineId}`;

export function loadCales(machineId: string): CalesRecord {
  try {
    const raw = localStorage.getItem(key(machineId));
    if (!raw) return emptyCales();
    const v = JSON.parse(raw) as Partial<CalesRecord>;
    const base = emptyCales();
    for (const h of CALE_HEIGHTS) {
      const s = v.status?.[h];
      if (s === 'present' || s === 'missing' || s === 'damaged') base.status[h] = s;
    }
    base.verifiedAt = typeof v.verifiedAt === 'number' ? v.verifiedAt : null;
    return base;
  } catch {
    return emptyCales();
  }
}

export function saveCales(machineId: string, r: CalesRecord): void {
  try {
    localStorage.setItem(key(machineId), JSON.stringify(r));
  } catch {
    /* storage unavailable: the preview still works for this visit */
  }
}
