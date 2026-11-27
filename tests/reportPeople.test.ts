import { describe, expect, it } from 'vitest';
import { reportPeople, reportRows } from '../src/lib/preventiveReport';
import type { MachinesReport } from '../src/lib/fleet';

const ev = (action: 'PROBLEM' | 'MISSED', username: string, note: string | null = 'Leak') => ({ machine_id: 'HAAS-1', check_title: 'Leak', action, note, username, at: 1 });

describe('report people', () => {
  it('counts every problem a person reported, the same as the summary (also those reported with the machine button)', () => {
    const data: MachinesReport = {
      // Server people counts problems found while confirming a check only (none here).
      events: [ev('PROBLEM', 'ali'), ev('PROBLEM', 'Ali'), ev('PROBLEM', 'test'), ev('MISSED', 'karim', 'ali')],
      cales: [],
      people: [{ username: 'karim', done: 4, problems: 0 }],
      hidden: ['test'],
      truncated: false,
      machines: [],
      taken: [],
    };
    const rows = reportRows(data, (id) => id, () => '');
    expect(reportPeople(data, rows)).toEqual([
      { username: 'karim', done: 4, problems: 0, notDone: 0 },
      { username: 'ali', done: 0, problems: 2, notDone: 1 },
    ]);
  });
});
