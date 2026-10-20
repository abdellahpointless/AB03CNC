import { api } from './api';
import i18n from '../i18n';
import type { MachineBrand, MachineInfo } from '../regions';
import { brandAccent } from './machines';

export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY';

export interface FleetMachine {
  id: string;
  /** Name shown to people (machines created in the app can have any name). */
  name: string;
  brand: MachineBrand;
  model: string;
  image: string;
  /** Brand colour used for the glow when the card is selected. */
  accent: string;
}

/** The current country's machines, in floor order, ready for Preventive actions. */
export function toFleet(machines: MachineInfo[]): FleetMachine[] {
  return [...machines]
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
    .map((m) => ({
      id: m.id,
      name: m.name,
      brand: m.brand,
      model: m.model,
      image: m.image || '/machines/generic.svg',
      accent: brandAccent(m.brand),
    }));
}

/** "HAAS VF-3" (no brand word for machines of another brand). */
export function machineSubtitle(m: Pick<FleetMachine, 'brand' | 'model'>): string {
  return [m.brand === 'OTHER' ? '' : m.brand, m.model].filter(Boolean).join(' ');
}

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
  action: 'DONE' | 'PROBLEM' | 'RESOLVE' | 'CHECK_ADDED' | 'CHECK_EDITED' | 'CHECK_REMOVED' | 'OWNERS_SET' | 'MACHINE_ADDED' | 'MACHINE_REMOVED';
  note: string | null;
  username: string;
  at: number;
}

/**
 * "Every day" / "Her gün". Each label is read when it is used, so it follows the page's language;
 * `FREQUENCY_LABEL[f]` and `Object.entries(FREQUENCY_LABEL)` work as before (same key order).
 */
export const FREQUENCY_LABEL: Record<Frequency, string> = {
  get DAILY() {
    return i18n.t('common:frequency.DAILY');
  },
  get WEEKLY() {
    return i18n.t('common:frequency.WEEKLY');
  },
  get MONTHLY() {
    return i18n.t('common:frequency.MONTHLY');
  },
  get QUARTERLY() {
    return i18n.t('common:frequency.QUARTERLY');
  },
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

export interface MachineOwner {
  machine_id: string;
  user_id: string;
  username: string;
}

export const fetchMachines = () =>
  api<{ checks: MachineCheck[]; events: MachineEvent[]; owners?: MachineOwner[]; serverTime: number }>('/machines');

export const setOwners = (machine: string, userIds: string[]) =>
  api(`/machines/${encodeURIComponent(machine)}/owners`, { method: 'PUT', body: { userIds } });

export const fetchUsers = () => api<{ users: { id: string; username: string; role: 'ADMIN' | 'MACHINIST' }[] }>('/users');

/**
 * Machines locked for a user: anyone responsible for at least one machine can only update
 * their own machines. Admins and people with no machine assigned can update every machine.
 */
export function isLockedFor(machineId: string, user: { id: string; role: string } | null | undefined, owners: MachineOwner[]): boolean {
  if (!user || user.role === 'ADMIN') return false;
  const mine = owners.filter((o) => o.user_id === user.id);
  return mine.length > 0 && !mine.some((o) => o.machine_id === machineId);
}

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

/** "3 min ago" / "3 dk önce": the localised version in src/i18n/format.ts. */
export { timeAgo } from '../i18n/format';
