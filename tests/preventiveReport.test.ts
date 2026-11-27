import { describe, expect, it } from 'vitest';
import { reportRows } from '../src/lib/preventiveReport';
import type { MachinesReport } from '../src/lib/fleet';

const report = (events: MachinesReport['events']): MachinesReport => ({ events, cales: [], people: [], hidden: [], truncated: false, machines: [], taken: [] });
const ev = (check_title: string | null, note: string | null) => ({ machine_id: 'HAAS-1', check_title, action: 'PROBLEM' as const, note, username: 'ali', at: 1 });

describe('report rows', () => {
  it('writes a problem text once when title and note are the same (a problem with the machine itself)', () => {
    const rows = reportRows(report([ev('Spindle noise', 'Spindle noise'), ev('Coolant', 'Level low'), ev('Coolant', null)]), (id) => id, () => '');
    expect(rows.map((r) => r.details)).toEqual(['Spindle noise', 'Coolant · Level low', 'Coolant']);
  });
});
