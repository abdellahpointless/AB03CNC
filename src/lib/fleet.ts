import { api } from './api';

export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY';

export interface FleetMachine {
  id: string;
  brand: 'HAAS' | 'FANUC' | 'DMG MORI';
  model: string;
  image: string;
  /** Brand colour used for the glow when the card is selected. */
  accent: string;
}

/** The machines shown in Preventive actions, in floor order. */
export const FLEET: FleetMachine[] = [
  { id: 'HAAS-1', brand: 'HAAS', model: 'VF-3', image: '/machines/haas-vf3.webp', accent: '#d32f2f' },
  { id: 'HAAS-2', brand: 'HAAS', model: 'VF-3', image: '/machines/haas-vf3.webp', accent: '#d32f2f' },
  { id: 'HAAS-3', brand: 'HAAS', model: 'VF-2', image: '/machines/haas-vf2.webp', accent: '#d32f2f' },
  { id: 'HAAS-4', brand: 'HAAS', model: 'VF-3', image: '/machines/haas-vf3.webp', accent: '#d32f2f' },
  { id: 'HAAS-5', brand: 'HAAS', model: 'VF-3', image: '/machines/haas-vf3.webp', accent: '#d32f2f' },
  { id: 'FANUC-1', brand: 'FANUC', model: 'Robodrill', image: '/machines/fanuc-robodrill.webp', accent: '#f5c400' },
  { id: 'FANUC-2', brand: 'FANUC', model: 'Robodrill', image: '/machines/fanuc-robodrill.webp', accent: '#f5c400' },
  { id: 'DMG-1', brand: 'DMG MORI', model: 'CMX 600 V', image: '/machines/dmg-cmx600v.webp', accent: '#9aa4b6' },
];

export interface MachineCheck {
  id: string;
  machine_id: string;
  kind: 'CHECK' | 'ISSUE';
  title: string;
  frequency: Frequency | null;
  status: 'OK' | 'PROBLEM';
  note: string | null;
  last_done_at: number | null;
  last_done_by: string | null;
  status_at: number | null;
  status_by: string | null;
  sort: number;
  created_at: number;
}

export interface MachineEvent {
  id: number;
  machine_id: string;
  check_id: string | null;
  check_title: string | null;
  action: 'DONE' | 'PROBLEM' | 'RESOLVE' | 'CHECK_ADDED' | 'CHECK_EDITED' | 'CHECK_REMOVED';
  note: string | null;
  username: string;
  at: number;
}

export const FREQUENCY_LABEL: Record<Frequency, string> = {
  DAILY: 'Every day',
  WEEKLY: 'Every week',
  MONTHLY: 'Every month',
  QUARTERLY: 'Every 3 months',
};

const DAY = 86_400_000;
const PERIOD_DAYS: Record<Frequency, number> = { DAILY: 1, WEEKLY: 7, MONTHLY: 30, QUARTERLY: 91 };

/** A checklist item is due when it wasn't done in its period (daily = not yet today). */
export function isDue(c: MachineCheck, now = Date.now()): boolean {
  if (c.kind !== 'CHECK' || !c.frequency) return false;
  if (!c.last_done_at) return true;
  if (c.frequency === 'DAILY') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return c.last_done_at < start.getTime();
  }
  return now - c.last_done_at >= PERIOD_DAYS[c.frequency] * DAY;
}

export type MachineState = 'problem' | 'due' | 'ok';

export function machineSummary(checks: MachineCheck[], now = Date.now()) {
  const problems = checks.filter((c) => c.status === 'PROBLEM');
  const due = checks.filter((c) => c.status !== 'PROBLEM' && isDue(c, now));
  const state: MachineState = problems.length ? 'problem' : due.length ? 'due' : 'ok';
  return { state, problems, due, total: checks.filter((c) => c.kind === 'CHECK').length };
}

export const fetchMachines = () => api<{ checks: MachineCheck[]; events: MachineEvent[]; serverTime: number }>('/machines');

export const checkAction = (machine: string, id: string, action: 'DONE' | 'PROBLEM' | 'RESOLVE', note?: string) =>
  api(`/machines/${encodeURIComponent(machine)}/checks/${encodeURIComponent(id)}/action`, { method: 'POST', body: { action, note } });

export const reportIssue = (machine: string, note: string) =>
  api(`/machines/${encodeURIComponent(machine)}/issues`, { method: 'POST', body: { note } });

export const createCheck = (machine: string, title: string, frequency: Frequency) =>
  api(`/machines/${encodeURIComponent(machine)}/checks`, { method: 'POST', body: { title, frequency } });

export const updateCheck = (machine: string, id: string, patch: { title?: string; frequency?: Frequency }) =>
  api(`/machines/${encodeURIComponent(machine)}/checks/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });

export const deleteCheck = (machine: string, id: string) =>
  api(`/machines/${encodeURIComponent(machine)}/checks/${encodeURIComponent(id)}`, { method: 'DELETE' });

export function timeAgo(ts: number | null, now = Date.now()): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
