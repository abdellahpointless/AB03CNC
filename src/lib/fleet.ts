import { api } from './api';
import i18n from '../i18n';
import type { MachineBrand, MachineInfo } from '../regions';
import { brandAccent } from './machines';
import { currentRegion } from './instance';
import { currentFeatures } from './features';
import { inEndWindow, periodKey, type Frequency } from './shifts';
import type { CaleRow, StockRow } from './cales';

export type { Frequency };

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
  /** 1: this open problem stops the machine (breakdown). Missing before the server knew it. */
  stops?: number;
}

export interface MachineEvent {
  id: number;
  machine_id: string;
  check_id: string | null;
  check_title: string | null;
  action:
    | 'DONE'
    | 'PROBLEM'
    | 'RESOLVE'
    | 'MACHINE_DOWN'
    | 'MACHINE_UP'
    | 'CHECK_ADDED'
    | 'CHECK_EDITED'
    | 'CHECK_REMOVED'
    | 'OWNERS_SET'
    | 'MACHINE_ADDED'
    | 'MACHINE_REMOVED'
    /** A start / end of shift task the previous shift did not do; `note` names the people. */
    | 'MISSED';
  note: string | null;
  username: string;
  at: number;
}

/**
 * "Every day" / "Her gün". Each label is read when it is used, so it follows the page's language;
 * `FREQUENCY_LABEL[f]` and `Object.entries(FREQUENCY_LABEL)` work as before (same key order).
 */
export const FREQUENCY_LABEL: Record<Frequency, string> = {
  get SHIFT_START() {
    return i18n.t('common:frequency.SHIFT_START');
  },
  get SHIFT_END() {
    return i18n.t('common:frequency.SHIFT_END');
  },
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
const PERIOD_DAYS: Record<Frequency, number> = { SHIFT_START: 1 / 3, SHIFT_END: 1 / 3, DAILY: 1, WEEKLY: 7, MONTHLY: 30, QUARTERLY: 91 };

/** An end of shift task is only asked for in the last 45 minutes of the shift. */
export const endTaskWaiting = (c: Pick<MachineCheck, 'frequency'>, now = Date.now()) =>
  c.frequency === 'SHIFT_END' && !inEndWindow(now, currentRegion().timeZone);

/**
 * A checklist item is due when it was not done in its period. With shift checks on, periods are
 * calendar ones in the country's time zone: today, this week (from Monday), this month (from the
 * 1st) or this quarter (Jan/Apr/Jul/Oct). Without: a daily check is due again at midnight, the
 * others 7, 30 or 91 days after they were done.
 */
export function isDue(c: MachineCheck, now = Date.now()): boolean {
  if (c.kind !== 'CHECK' || !c.frequency || endTaskWaiting(c, now)) return false;
  if (!c.last_done_at) return true;
  if (currentFeatures().shiftChecks || c.frequency === 'SHIFT_START' || c.frequency === 'SHIFT_END') {
    const tz = currentRegion().timeZone;
    return periodKey(c.frequency, c.last_done_at, tz) !== periodKey(c.frequency, now, tz);
  }
  if (c.frequency === 'DAILY') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return c.last_done_at < start.getTime();
  }
  return now - c.last_done_at >= PERIOD_DAYS[c.frequency] * DAY;
}

export type MachineState = 'problem' | 'due' | 'ok';

/** An open problem that stops the machine (breakdown). */
export const stopsMachine = (c: MachineCheck) => c.status === 'PROBLEM' && !!c.stops;

export function machineSummary(checks: MachineCheck[], now = Date.now()) {
  const problems = checks.filter((c) => c.status === 'PROBLEM');
  const due = checks.filter((c) => c.status !== 'PROBLEM' && isDue(c, now));
  const state: MachineState = problems.length ? 'problem' : due.length ? 'due' : 'ok';
  const stopping = problems.filter(stopsMachine);
  return {
    state,
    problems,
    due,
    total: checks.filter((c) => c.kind === 'CHECK').length,
    /** The machine is stopped by at least one open problem. */
    down: stopping.length > 0,
    /** Since when it is stopped (the oldest of those problems). */
    downSince: stopping.length ? Math.min(...stopping.map((c) => c.status_at ?? now)) : null,
  };
}

export interface MachineOwner {
  machine_id: string;
  user_id: string;
  username: string;
}

export const fetchMachines = () =>
  api<{
    checks: MachineCheck[];
    events: MachineEvent[];
    owners?: MachineOwner[];
    serverTime: number;
    /** Checks I did myself in their current period (everyone does every due check). */
    myDone: string[];
    /** Missing / damaged pairs of every cales box. */
    cales: CaleRow[];
    /** Machines whose cales box I confirmed this shift. */
    calesChecked: string[];
    /** Pairs with new cales asked for (open requests). */
    calesRequests: { machine_id: string; height: number }[];
    /** The shift before this one: who confirmed its start / end tasks, and who worked on each machine. */
    prevShift: { key: string; done: { check_id: string; username: string }[]; people: { machine_id: string; username: string }[] };
  }>('/machines');

export type RequiredItem = { kind: 'CHECK'; machineId: string; id: string; title: string } | { kind: 'CALES'; machineId: string };
/** What I must do before using the rest of the app (nothing for admins). */
export const fetchRequired = () =>
  api<{
    locked: boolean;
    items: RequiredItem[];
    /** End of shift tasks still to do, in the last 45 minutes of the shift. */
    ending: RequiredItem[];
    shift: { n: 1 | 2 | 3; key: string };
    /** When this shift ends. */
    endsAt: number;
  }>('/machines/required');

/** A start / end of shift task was not done in the previous shift (the server names who). */
export const reportMissed = (machine: string, id: string) =>
  api(`/machines/${encodeURIComponent(machine)}/checks/${encodeURIComponent(id)}/missed`, { method: 'POST' });

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

export const checkAction = (machine: string, id: string, action: 'DONE' | 'PROBLEM' | 'RESOLVE', note?: string, stops?: boolean) =>
  api(`/machines/${encodeURIComponent(machine)}/checks/${encodeURIComponent(id)}/action`, { method: 'POST', body: { action, note, stops } });

/** The machine's vise is damaged (fixed again with checkAction RESOLVE on viseId). */
export const reportVise = (machine: string, note?: string) => api(`/machines/${encodeURIComponent(machine)}/vise`, { method: 'POST', body: { note } });

export const reportIssue = (machine: string, note: string, stops = false) =>
  api(`/machines/${encodeURIComponent(machine)}/issues`, { method: 'POST', body: { note, stops } });

/** Says whether an open problem stops the machine (or no longer does). */
export const setStops = (machine: string, id: string, stops: boolean) =>
  api(`/machines/${encodeURIComponent(machine)}/checks/${encodeURIComponent(id)}/action`, { method: 'POST', body: { action: 'STOPS', stops } });

export const createCheck = (machine: string, title: string, frequency: Frequency) =>
  api(`/machines/${encodeURIComponent(machine)}/checks`, { method: 'POST', body: { title, frequency } });

export const updateCheck = (machine: string, id: string, patch: { title?: string; frequency?: Frequency }) =>
  api(`/machines/${encodeURIComponent(machine)}/checks/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });

export const deleteCheck = (machine: string, id: string) =>
  api(`/machines/${encodeURIComponent(machine)}/checks/${encodeURIComponent(id)}`, { method: 'DELETE' });

const cales = (machine: string, what: string, body?: unknown) => api(`/machines/${encodeURIComponent(machine)}/cales/${what}`, { method: 'POST', body });
/** A pair (or one cale of it) is missing or damaged, or a missing pair turned up again. */
export const reportCales = (machine: string, height: number, kind: 'MISSING' | 'DAMAGED' | 'FOUND', count: 1 | 2 = 2) => cales(machine, 'report', { height, kind, count });
/** "I found all the cales / all the rest", for this shift. */
export const confirmCales = (machine: string) => cales(machine, 'confirm');
/** Ask for new cales for a missing or damaged pair. */
export const requestCales = (machine: string, height: number) => cales(machine, 'request', { height });

export interface CaleRequest {
  id: string;
  machine_id: string;
  height: number;
  kind: 'MISSING' | 'DAMAGED';
  count: number;
  requested_by: string;
  at: number;
}
export interface CaleEvent {
  machine_id: string;
  height: number;
  kind: 'MISSING' | 'DAMAGED' | 'FOUND' | 'REPLACED';
  count: number;
  username: string;
  shift_key: string;
  at: number;
}
/** Cales a machine took from the general stock (an approved request). */
export interface CaleTaken {
  machine_id: string;
  height: number;
  count: number;
  requested_by: string;
  decided_by: string;
  at: number;
}
/** Admin: the general spare stock per size, open requests, the state of every box, what the machines took. */
export const fetchCalesStock = () => api<{ stock: StockRow[]; requests: CaleRequest[]; state: CaleRow[]; taken: CaleTaken[] }>('/machines/cales/stock');
export const setCalesStock = (height: number, qty: number) => api(`/machines/cales/stock/${height}`, { method: 'PUT', body: { qty } });
export const decideCales = (id: string, decision: 'APPROVE' | 'REJECT') =>
  api(`/machines/cales/requests/${encodeURIComponent(id)}`, { method: 'POST', body: { decision } });
/** Every cales report from `from` to `to` (ms, end excluded). */
export const fetchCalesLog = (from: number, to: number) => api<{ events: CaleEvent[] }>(`/machines/cales/log?from=${from}&to=${to}`);

/** "3 min ago" / "3 dk önce": the localised version in src/i18n/format.ts. */
export { timeAgo } from '../i18n/format';

/** Admin: what went wrong in a period, and how many checks each person confirmed. */
export interface MachinesReport {
  events: { machine_id: string; check_title: string | null; action: 'PROBLEM' | 'MACHINE_DOWN' | 'MISSED'; note: string | null; username: string; at: number }[];
  cales: { machine_id: string; height: number; kind: 'MISSING' | 'DAMAGED'; count: number; username: string; at: number }[];
  people: { username: string; done: number; problems: number }[];
  hidden: string[];
  /** More events than the list holds: only the newest are in it. */
  truncated: boolean;
  /** Per machine: checks and cales boxes confirmed in the period (hidden accounts left out). */
  machines: { machine_id: string; checks: number; problems: number; cales: number }[];
  /** Cales taken from the general stock in the period (approved requests). */
  taken: CaleTaken[];
}
export const fetchMachinesReport = (from: number, to: number) => api<MachinesReport>(`/machines/report?from=${from}&to=${to}`);
/** Admin: how many single cales of a pair are really in the machine's box (0, 1 or 2). */
export const setCalesOnMachine = (machine: string, height: number, present: 0 | 1 | 2) =>
  api(`/machines/cales/onmachine/${encodeURIComponent(machine)}/${height}`, { method: 'PUT', body: { present } });
