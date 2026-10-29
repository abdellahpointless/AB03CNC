import type { MachinesReport } from './fleet';

/*
 * What went wrong in a period, and who confirmed their checks: built from the saved records
 * (GET /machines/report). The Reports page and the daily printable report both use it, so a day's
 * report is never stored: it is rebuilt from the records, for any day, at no storage cost.
 */

export type ReportKind = 'PROBLEM' | 'MACHINE_DOWN' | 'MISSED' | 'CALES_MISSING' | 'CALES_DAMAGED';
export interface ReportRow {
  at: number;
  machine: string;
  kind: ReportKind;
  details: string;
  notDoneBy: string;
  by: string;
}
export interface ReportPerson {
  username: string;
  done: number;
  problems: number;
  notDone: number;
}

/** Every problem, stop, "not done" report and missing or damaged cale, newest first. */
export function reportRows(data: MachinesReport, nameOf: (id: string) => string, caleDetails: (h: number, count: number) => string): ReportRow[] {
  const out: ReportRow[] = data.events.map((e) => ({
    at: e.at,
    machine: nameOf(e.machine_id),
    kind: e.action,
    details: e.action === 'PROBLEM' ? [e.check_title, e.note].filter(Boolean).join(' · ') : e.check_title ?? e.note ?? '',
    notDoneBy: e.action === 'MISSED' ? e.note ?? '' : '',
    by: e.username,
  }));
  for (const c of data.cales)
    out.push({
      at: c.at,
      machine: nameOf(c.machine_id),
      kind: c.kind === 'MISSING' ? 'CALES_MISSING' : 'CALES_DAMAGED',
      details: caleDetails(c.height, c.count),
      notDoneBy: '',
      by: c.username,
    });
  return out.sort((a, b) => b.at - a.at);
}

/** Per person: checks and cales boxes confirmed, problems found, and how often reported for a task not done. */
export function reportPeople(data: MachinesReport, rows: ReportRow[]): ReportPerson[] {
  const map = new Map<string, ReportPerson>();
  const get = (u: string) => {
    const k = u.toLowerCase();
    if (!map.has(k)) map.set(k, { username: u, done: 0, problems: 0, notDone: 0 });
    return map.get(k)!;
  };
  for (const p of data.people) Object.assign(get(p.username), { done: p.done, problems: p.problems });
  for (const r of rows)
    if (r.kind === 'MISSED')
      for (const u of r.notDoneBy.split(',').map((s) => s.trim()).filter(Boolean)) if (!data.hidden.includes(u.toLowerCase())) get(u).notDone++;
  return [...map.values()].sort((a, b) => b.done - a.done || a.notDone - b.notDone);
}
