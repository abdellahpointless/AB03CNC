import { describe, expect, it } from 'vitest';
import { currentPeriods, dayStart, inEndWindow, periodKey, periodStart, previousShift, shiftOf, shiftStart } from '../src/lib/shifts';

const IST = 'Europe/Istanbul'; // UTC+3 all year
const CAS = 'Africa/Casablanca';
const at = (iso: string) => Date.parse(iso);

describe('shifts', () => {
  it('splits the day at 08:00, 16:00 and midnight, local time', () => {
    expect(shiftOf(at('2026-10-24T04:59:59Z'), IST)).toEqual({ n: 3, key: '2026-10-24-S3' }); // 07:59:59
    expect(shiftOf(at('2026-10-24T05:00:00Z'), IST)).toEqual({ n: 1, key: '2026-10-24-S1' }); // 08:00
    expect(shiftOf(at('2026-10-24T12:59:59Z'), IST)).toEqual({ n: 1, key: '2026-10-24-S1' }); // 15:59:59
    expect(shiftOf(at('2026-10-24T13:00:00Z'), IST)).toEqual({ n: 2, key: '2026-10-24-S2' }); // 16:00
    expect(shiftOf(at('2026-10-24T20:59:59Z'), IST)).toEqual({ n: 2, key: '2026-10-24-S2' }); // 23:59:59
    expect(shiftOf(at('2026-10-24T21:00:00Z'), IST)).toEqual({ n: 3, key: '2026-10-25-S3' }); // 00:00 next day
  });

  it('follows summer time', () => {
    // Paris changes to summer time on 2026-03-29 at 01:00 UTC: 06:30 UTC is 08:30 there, not 07:30.
    expect(shiftOf(at('2026-03-29T06:30:00Z'), 'Europe/Paris').n).toBe(1);
    expect(shiftOf(at('2026-03-28T06:30:00Z'), 'Europe/Paris').n).toBe(3);
    // Morocco is UTC+1 outside Ramadan.
    expect(shiftOf(at('2026-07-15T07:30:00Z'), CAS)).toEqual({ n: 1, key: '2026-07-15-S1' });
  });
});

describe('check periods', () => {
  it('a day starts at local midnight', () => {
    expect(periodKey('DAILY', at('2026-10-24T20:59:00Z'), IST)).toBe('2026-10-24');
    expect(periodKey('DAILY', at('2026-10-24T21:00:00Z'), IST)).toBe('2026-10-25');
  });

  it('a week starts on Monday (ISO weeks)', () => {
    const sunday = periodKey('WEEKLY', at('2026-10-25T20:59:00Z'), IST); // Sunday 23:59
    const monday = periodKey('WEEKLY', at('2026-10-25T21:00:00Z'), IST); // Monday 00:00
    expect(sunday).toBe('2026-W43');
    expect(monday).toBe('2026-W44');
    expect(periodKey('WEEKLY', at('2026-01-01T12:00:00Z'), IST)).toBe('2026-W01'); // a Thursday
    expect(periodKey('WEEKLY', at('2027-01-01T12:00:00Z'), IST)).toBe('2026-W53'); // a Friday: still 2026's week
  });

  it('months and quarters start on the 1st', () => {
    expect(periodKey('MONTHLY', at('2026-03-31T20:59:00Z'), IST)).toBe('2026-03');
    expect(periodKey('MONTHLY', at('2026-03-31T21:00:00Z'), IST)).toBe('2026-04');
    expect(periodKey('QUARTERLY', at('2026-03-31T20:59:00Z'), IST)).toBe('2026-Q1');
    expect(periodKey('QUARTERLY', at('2026-03-31T21:00:00Z'), IST)).toBe('2026-Q2');
    expect(periodKey('QUARTERLY', at('2026-12-31T12:00:00Z'), IST)).toBe('2026-Q4');
  });

  it('lists the current period of every frequency', () => {
    expect(currentPeriods(at('2026-10-24T09:00:00Z'), IST)).toEqual(['2026-10-24', '2026-W43', '2026-10', '2026-Q4', '2026-10-24-S1']);
  });
});

describe('period starts (for exports)', () => {
  it('finds local midnight, also on a summer-time day', () => {
    expect(dayStart(2026, 10, 19, IST)).toBe(at('2026-10-18T21:00:00Z'));
    expect(dayStart(2026, 10, 24, CAS)).toBe(at('2026-10-23T23:00:00Z'));
    expect(dayStart(2026, 3, 29, 'Europe/Paris')).toBe(at('2026-03-28T23:00:00Z')); // still winter time at midnight
    expect(dayStart(2026, 3, 30, 'Europe/Paris')).toBe(at('2026-03-29T22:00:00Z'));
    expect(dayStart(2026, 10, 32, IST)).toBe(at('2026-10-31T21:00:00Z')); // Oct 32 = Nov 1
  });

  it('starts the week on Monday and the month on the 1st, local time', () => {
    const sat = at('2026-10-24T12:00:00+03:00');
    expect(periodStart('WEEKLY', sat, IST)).toBe(at('2026-10-19T00:00:00+03:00'));
    expect(periodStart('MONTHLY', sat, IST)).toBe(at('2026-10-01T00:00:00+03:00'));
    expect(periodStart('WEEKLY', at('2026-10-19T00:30:00+01:00'), CAS)).toBe(at('2026-10-19T00:00:00+01:00')); // Monday itself
    expect(periodStart('WEEKLY', at('2026-11-01T10:00:00+01:00'), CAS)).toBe(at('2026-10-26T00:00:00+01:00')); // Sunday, across months
  });
});

describe('start and end of shift tasks', () => {
  it('are due once per shift', () => {
    expect(periodKey('SHIFT_START', at('2026-10-24T05:30:00Z'), IST)).toBe('2026-10-24-S1');
    expect(periodKey('SHIFT_END', at('2026-10-24T20:59:00Z'), IST)).toBe('2026-10-24-S2');
  });

  it('knows when the shift started, the last 45 minutes, and the shift before', () => {
    expect(shiftStart(at('2026-10-24T12:44:30Z'), IST)).toBe(at('2026-10-24T05:00:00Z')); // 15:44:30 -> 08:00
    expect(shiftStart(at('2026-10-24T22:10:00Z'), IST)).toBe(at('2026-10-24T21:00:00Z')); // 01:10 -> 00:00
    expect(inEndWindow(at('2026-10-24T12:14:59Z'), IST)).toBe(false); // 15:14:59
    expect(inEndWindow(at('2026-10-24T12:15:00Z'), IST)).toBe(true); // 15:15
    expect(inEndWindow(at('2026-10-24T20:59:59Z'), IST)).toBe(true); // 23:59:59
    expect(previousShift(at('2026-10-24T05:00:00Z'), IST).key).toBe('2026-10-24-S3'); // 08:00 -> night shift
    expect(previousShift(at('2026-10-24T22:00:00Z'), IST).key).toBe('2026-10-24-S2'); // 01:00 -> 16-24 of the day before
  });
});
