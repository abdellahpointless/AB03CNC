/** Highest rpm and feed (mm/min) of the machine (CAM AI never goes over them). */
export interface Limits {
  maxRpm: number;
  maxFeed: number;
}
/** When the machine has none set (Admin > Machines). */
export const DEFAULT_LIMITS: Limits = { maxRpm: 12_000, maxFeed: 10_000 };
