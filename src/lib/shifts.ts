/*
 * Shifts and check periods, in the country's own time zone. Shared by the app and the Worker.
 *
 *   shift 1: 08:00-16:00   shift 2: 16:00-24:00   shift 3: 00:00-08:00
 *
 * A check is due once per period: every shift (at its start, or in its last 45 minutes), every day,
 * every week (from Monday), every month (from the 1st) or every quarter (from the 1st of January,
 * April, July and October).
 */

export type Frequency = 'SHIFT_START' | 'SHIFT_END' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY';

const formats = new Map<string, Intl.DateTimeFormat>();

/** Local date and time at `at` in `timeZone`. */
function local(at: number, timeZone: string) {
  let f = formats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    formats.set(timeZone, f);
  }
  const parts = f.formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute') };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The shift running at `at`, and its key ("2026-10-24-S1"), unique for that shift on that day. */
export function shiftOf(at: number, timeZone: string): { n: 1 | 2 | 3; key: string } {
  const l = local(at, timeZone);
  const n = l.h < 8 ? 3 : l.h < 16 ? 1 : 2;
  return { n, key: `${l.y}-${pad(l.m)}-${pad(l.d)}-S${n}` };
}

/** The period a check done at `at` counts for: 2026-10-24, 2026-W43, 2026-10 or 2026-Q4. */
export function periodKey(freq: Frequency, at: number, timeZone: string): string {
  if (freq === 'SHIFT_START' || freq === 'SHIFT_END') return shiftOf(at, timeZone).key;
  const l = local(at, timeZone);
  if (freq === 'DAILY') return `${l.y}-${pad(l.m)}-${pad(l.d)}`;
  if (freq === 'MONTHLY') return `${l.y}-${pad(l.m)}`;
  if (freq === 'QUARTERLY') return `${l.y}-Q${Math.ceil(l.m / 3)}`;
  // ISO week: starts on Monday and belongs to the year of its Thursday.
  const t = new Date(Date.UTC(l.y, l.m - 1, l.d));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y = t.getUTCFullYear();
  return `${y}-W${pad(Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7))}`;
}

/** The current period of each frequency, in the order DAILY, WEEKLY, MONTHLY, QUARTERLY, shift. */
export const currentPeriods = (at: number, timeZone: string) =>
  (['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'SHIFT_START'] as const).map((f) => periodKey(f, at, timeZone));

export const SHIFT_MS = 8 * 3_600_000;
/** End-of-shift tasks are asked for in the last 45 minutes of the shift. */
export const END_WARNING_MS = 45 * 60_000;

/**
 * When the shift running at `at` started.
 * shortcut: assumes the clock does not change during the shift; a night shift on a summer-time
 * change is off by an hour, once or twice a year.
 */
export function shiftStart(at: number, timeZone: string): number {
  const l = local(at, timeZone);
  const startHour = l.h < 8 ? 0 : l.h < 16 ? 8 : 16;
  return at - ((l.h - startHour) * 60 + l.min) * 60_000 - (at % 60_000);
}

/** In the last 45 minutes of the shift: time for the end-of-shift tasks. */
export const inEndWindow = (at: number, timeZone: string) => shiftStart(at, timeZone) + SHIFT_MS - at <= END_WARNING_MS;

/** The shift before the one running at `at`. */
export const previousShift = (at: number, timeZone: string) => shiftOf(shiftStart(at, timeZone) - 1, timeZone);

/** The instant the local day y-m-d starts (00:00) in `timeZone`; d may overflow (Oct 32 = Nov 1). */
export function dayStart(y: number, m: number, d: number, timeZone: string): number {
  const want = Date.UTC(y, m - 1, d);
  let t = want;
  // Moves by the zone's offset; the second pass settles it when the offset changes that night.
  for (let i = 0; i < 2; i++) {
    const l = local(t, timeZone);
    t += want - Date.UTC(l.y, l.m - 1, l.d, l.h, l.min);
  }
  return t;
}

/** Monday 00:00 of the week of `at`, or the 1st 00:00 of its month, in `timeZone`. */
export function periodStart(freq: 'WEEKLY' | 'MONTHLY', at: number, timeZone: string): number {
  const l = local(at, timeZone);
  if (freq === 'MONTHLY') return dayStart(l.y, l.m, 1, timeZone);
  const back = (new Date(Date.UTC(l.y, l.m - 1, l.d)).getUTCDay() + 6) % 7;
  return dayStart(l.y, l.m, l.d - back, timeZone);
}
