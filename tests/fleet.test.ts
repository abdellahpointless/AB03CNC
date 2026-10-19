import { describe, expect, it } from 'vitest';
import { isDue, machineSummary, type MachineCheck } from '../src/lib/fleet';

const base: MachineCheck = {
  id: 'c', machine_id: 'HAAS-1', kind: 'CHECK', title: 'Coolant', frequency: 'DAILY', status: 'OK', note: null,
  last_done_at: null, last_done_by: null, status_at: null, status_by: null, sort: 0, created_at: 0,
};
const at = (s: string) => new Date(s).getTime();

describe('preventive checks', () => {
  it('a daily check is due until it is done today', () => {
    const now = at('2026-10-19T10:00:00');
    expect(isDue(base, now)).toBe(true);
    expect(isDue({ ...base, last_done_at: at('2026-10-18T23:00:00') }, now)).toBe(true);
    expect(isDue({ ...base, last_done_at: at('2026-10-19T07:30:00') }, now)).toBe(false);
  });
  it('weekly / monthly checks use the number of days since they were done', () => {
    const now = at('2026-10-19T10:00:00');
    expect(isDue({ ...base, frequency: 'WEEKLY', last_done_at: at('2026-10-14T10:00:00') }, now)).toBe(false);
    expect(isDue({ ...base, frequency: 'WEEKLY', last_done_at: at('2026-10-12T09:00:00') }, now)).toBe(true);
    expect(isDue({ ...base, frequency: 'MONTHLY', last_done_at: at('2026-10-01T10:00:00') }, now)).toBe(false);
  });
  it('a problem makes the machine red even if checks are due', () => {
    const now = at('2026-10-19T10:00:00');
    const s = machineSummary([base, { ...base, id: 'p', kind: 'ISSUE', frequency: null, status: 'PROBLEM', note: 'Leak' }], now);
    expect(s.state).toBe('problem');
    expect(s.problems).toHaveLength(1);
    expect(machineSummary([{ ...base, last_done_at: now }], now).state).toBe('ok');
    expect(machineSummary([base], now).state).toBe('due');
  });
});
