/*
 * The cales (parallels) box that comes with each machine: two aluminium cales per height, always
 * used together as a pair. The box holds one pair per slot, tallest on the left.
 *
 * The state of every box is kept on the server (worker/routes/cales.ts) and shared by everyone who
 * uses the machine. Only pairs that are missing or damaged are listed; every other pair is in place.
 */

/**
 * The machine vise (mengene) next to the box: good until someone reports it damaged. The report is an
 * open problem on the machine with this fixed id, so it can only be open once and is fixed like any other.
 */
export const viseId = (machine: string) => `vise-${machine}`;

/** Heights in mm, in slot order (left → right as the box is seen from the front). */
export const CALE_HEIGHTS = [43, 42, 41, 40, 38, 35, 33, 30, 28, 25, 22, 20, 15, 8] as const;
export type CaleHeight = (typeof CALE_HEIGHTS)[number];

export type CaleStatus = 'present' | 'missing' | 'damaged';

/** A pair that is not in good shape, and how many of its two cales are concerned. */
export interface CalePair {
  status: Exclude<CaleStatus, 'present'>;
  count: 1 | 2;
}
/** Pairs of one box that are missing or damaged, by height. */
export type CalesState = Record<number, CalePair>;

/** A row as the server sends it. */
export interface CaleRow {
  machine_id: string;
  height: number;
  status: 'MISSING' | 'DAMAGED';
  count: number;
}

export function calesOf(rows: CaleRow[], machineId: string): CalesState {
  const out: CalesState = {};
  for (const r of rows)
    if (r.machine_id === machineId) out[r.height] = { status: r.status === 'MISSING' ? 'missing' : 'damaged', count: r.count === 1 ? 1 : 2 };
  return out;
}

export const statusOf = (state: CalesState, h: number): CaleStatus => state[h]?.status ?? 'present';

/** Heights missing / damaged (box order), and how many single cales that is. */
export function calesSummary(state: CalesState) {
  const pick = (s: CalePair['status']) => CALE_HEIGHTS.filter((h) => state[h]?.status === s);
  const cales = (hs: number[]) => hs.reduce((n, h) => n + state[h].count, 0);
  const missing = pick('missing');
  const damaged = pick('damaged');
  return { missing, damaged, missingCales: cales(missing), damagedCales: cales(damaged) };
}

export interface StockRow {
  height: number;
  /** Spare single cales of this size on hand, shared by every machine. */
  qty: number;
}

/** The general stock under this many single cales of a size goes on the order. */
export const MIN_SPARE = 4;

/** Every size with fewer than MIN_SPARE spare cales, and how many bring it back to MIN_SPARE. */
export function lowStock(stock: StockRow[]) {
  const spare = new Map(stock.map((s) => [s.height, s.qty]));
  return CALE_HEIGHTS.map((h) => ({ height: h as number, stock: spare.get(h) ?? 0 }))
    .filter((r) => r.stock < MIN_SPARE)
    .map((r) => ({ ...r, need: MIN_SPARE - r.stock }));
}

/** What to order per size, in single cales: every pair still missing or damaged on any machine, less the general stock. */
export function orderRows(state: CaleRow[], stock: StockRow[]) {
  const spare = new Map(stock.map((s) => [s.height, s.qty]));
  return CALE_HEIGHTS.map((h) => {
    const rows = state.filter((r) => r.height === h);
    const missing = rows.reduce((n, r) => n + (r.status === 'MISSING' ? r.count : 0), 0);
    const damaged = rows.reduce((n, r) => n + (r.status === 'DAMAGED' ? r.count : 0), 0);
    const qty = spare.get(h) ?? 0;
    return { height: h as number, missing, damaged, stock: qty, toOrder: Math.max(0, missing + damaged - qty) };
  }).filter((r) => r.missing || r.damaged);
}
