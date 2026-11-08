/** Highest rpm and feed (mm/min) of the machine (CAM AI never goes over them). */
export interface Limits {
  maxRpm: number;
  maxFeed: number;
}
/** When the machine has none set (Admin > Machines). */
export const DEFAULT_LIMITS: Limits = { maxRpm: 12_000, maxFeed: 10_000 };

/**
 * Material cut out of the part that the model keeps, as the simulation sees it (mm³): more than this
 * is an overcut (a gouge) and the program may not go out. Smaller pieces are the simulation's own
 * grid, which cannot tell a skin that thin from the model's surface.
 */
export const GOUGE_MM3 = 5;
