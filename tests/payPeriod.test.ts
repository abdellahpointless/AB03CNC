import { describe, expect, it } from 'vitest';
import { payPeriod, shiftPeriod } from '../src/lib/partsApi';

describe('26th to 26th period', () => {
  it('starts on the 26th of this month from the 26th on, else on the 26th of last month', () => {
    expect(payPeriod(new Date(2026, 9, 10))).toEqual({ from: '2026-09-26', to: '2026-10-26' });
    expect(payPeriod(new Date(2026, 9, 26))).toEqual({ from: '2026-10-26', to: '2026-11-26' });
    expect(payPeriod(new Date(2026, 9, 25, 23, 59))).toEqual({ from: '2026-09-26', to: '2026-10-26' });
  });
  it('crosses the new year', () => {
    expect(payPeriod(new Date(2027, 0, 5))).toEqual({ from: '2026-12-26', to: '2027-01-26' });
    expect(payPeriod(new Date(2026, 11, 28))).toEqual({ from: '2026-12-26', to: '2027-01-26' });
  });
  it('moves a chosen period by whole months', () => {
    expect(shiftPeriod({ from: '2026-12-26', to: '2027-01-26' }, 1)).toEqual({ from: '2027-01-26', to: '2027-02-26' });
    expect(shiftPeriod({ from: '2026-01-26', to: '2026-02-26' }, -1)).toEqual({ from: '2025-12-26', to: '2026-01-26' });
  });
});
