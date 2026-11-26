import { describe, expect, it } from 'vitest';
import { fmtClock } from '../src/i18n/format';

describe('fmtClock', () => {
  it('rounds the whole time before splitting it, so it never shows :60', () => {
    expect(fmtClock(0)).toBe('0:00');
    expect(fmtClock(59.6)).toBe('1:00');
    expect(fmtClock(239.5)).toBe('4:00');
    expect(fmtClock(479.7)).toBe('8:00');
    expect(fmtClock(65.4)).toBe('1:05');
    expect(fmtClock(6258)).toBe('104:18');
  });
});
