import { describe, expect, it } from 'vitest';
import { historyToCsv } from '../src/components/HistoryView';
import { fmtDateTime } from '../src/i18n/format';
import type { HistoryRecord } from '../src/types';

// History CSV: the date in the app's format from the record's time, not the text of the PC that made it.
const record = (over: Partial<HistoryRecord>): HistoryRecord =>
  ({ id: 'r1', date: '11/26/2026, 11:05:54 PM', user: 'ali', machine: 'HAAS-1', originalFileName: 'P1.NC', exportedFileName: 'P1.NC', changes: [], ...over }) as HistoryRecord;

describe('history CSV date', () => {
  it('formats the record time like the screen', () => {
    const ts = Date.UTC(2026, 10, 26, 22, 5, 54);
    const row = historyToCsv([record({ timestamp: ts })]).split('\n')[1];
    expect(row.startsWith(`"${fmtDateTime(ts)}",`)).toBe(true);
    expect(row).not.toContain('PM');
  });

  it('keeps the stored text for an old record without a time', () => {
    const row = historyToCsv([record({ timestamp: undefined })]).split('\n')[1];
    expect(row.startsWith('"11/26/2026, 11:05:54 PM",')).toBe(true);
  });
});
