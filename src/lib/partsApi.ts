import { api } from './api';
import i18n from '../i18n';
import type { MonthlySummaryRow, PartEntry, PartKind } from '../types';

export function getDeviceLocalMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function validateSapNumber(raw: string): { isValid: boolean; sanitized: string; error?: string } {
  const sanitized = raw.trim().toUpperCase();
  if (!sanitized) return { isValid: false, sanitized: '', error: i18n.t('parts:validation.sapEmpty') };
  if (sanitized.length > 40) return { isValid: false, sanitized, error: i18n.t('parts:validation.sapTooLong') };
  if (!/^[A-Z0-9\-_.]+$/.test(sanitized)) {
    return { isValid: false, sanitized, error: i18n.t('parts:validation.sapChars') };
  }
  return { isValid: true, sanitized };
}

export function validateQuantity(raw: number | string): { isValid: boolean; qty: number; error?: string } {
  const val = typeof raw === 'number' ? raw : parseInt(String(raw).trim(), 10);
  if (isNaN(val) || !Number.isInteger(val)) return { isValid: false, qty: 0, error: i18n.t('parts:validation.qtyNotInteger') };
  if (val < 1 || val > 9999) return { isValid: false, qty: val, error: i18n.t('parts:validation.qtyRange') };
  return { isValid: true, qty: val };
}

type Result<T> = { success: true } & T | { success: false; error: string } & Partial<T>;

async function wrap<T>(fn: () => Promise<T>, fallback: T): Promise<Result<T>> {
  try {
    return { success: true, ...(await fn()) } as Result<T>;
  } catch (err: any) {
    return { success: false, error: err?.message || i18n.t('parts:errors.requestFailed'), ...fallback } as Result<T>;
  }
}

function normalizeSummary(rows: any[]): MonthlySummaryRow[] {
  return rows.map((r) => ({
    month_key: String(r.month_key),
    user_id: String(r.user_id),
    username: String(r.username || ''),
    total_qty: Number(r.total_qty || 0),
    total_value: Number(r.total_value || 0),
  }));
}

/** Creates a PENDING entry for the signed-in user. The id makes accidental double-submits harmless. */
export function submitPartEntry(params: { sapNumber: string; qty: number; kind: PartKind }) {
  return wrap(
    () =>
      api<{ entry: PartEntry }>('/parts', {
        method: 'POST',
        body: { id: crypto.randomUUID(), ...params, monthKey: getDeviceLocalMonthKey() },
      }),
    { entry: undefined as unknown as PartEntry },
  );
}

export function fetchUserMonthlySummary() {
  return wrap(async () => ({ rows: normalizeSummary((await api<{ rows: any[] }>('/parts/summary')).rows) }), { rows: [] as MonthlySummaryRow[] });
}

export function fetchMonthApprovedEntries(monthKey: string, page = 0) {
  return wrap(() => api<{ entries: any[]; hasMore: boolean }>(`/parts/month/${encodeURIComponent(monthKey)}?page=${page}`), {
    entries: [] as any[],
    hasMore: false,
  });
}

export async function fetchUserApprovedEntriesForExport(): Promise<any[]> {
  const out: any[] = [];
  for (let offset = 0; ; offset += 500) {
    const res = await api<{ entries: any[]; hasMore: boolean }>(`/parts/export?offset=${offset}`);
    out.push(...res.entries);
    if (!res.hasMore) return out;
  }
}

export function fetchPendingEntries(page = 0) {
  return wrap(() => api<{ entries: PartEntry[]; hasMore: boolean }>(`/parts/pending?page=${page}`), {
    entries: [] as PartEntry[],
    hasMore: false,
  });
}

export function reviewPartEntries(ids: string[], status: 'APPROVED' | 'REJECTED') {
  return wrap(() => api<{ updated: number }>('/parts/review', { method: 'POST', body: { ids, status } }), { updated: 0 });
}

/** A period of days on this PC's calendar, YYYY-MM-DD; the end day is not included. */
export interface PartsPeriod {
  from: string;
  to: string;
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayMs = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};

/** The 26th-to-26th period that holds `at`, moved by `by` periods (-1 = the one before). */
export function payPeriod(at = new Date(), by = 0): PartsPeriod {
  const m = at.getMonth() + by - (at.getDate() < 26 ? 1 : 0);
  return { from: ymd(new Date(at.getFullYear(), m, 26)), to: ymd(new Date(at.getFullYear(), m + 1, 26)) };
}

/** The same period one month earlier (-1) or later (1), keeping the chosen days. */
export function shiftPeriod(p: PartsPeriod, by: number): PartsPeriod {
  const move = (s: string) => {
    const [y, m, d] = s.split('-').map(Number);
    return ymd(new Date(y, m - 1 + by, d));
  };
  return { from: move(p.from), to: move(p.to) };
}

/** The period as times (ms) on this PC's calendar, the end excluded. */
export const periodMs = (p: PartsPeriod) => ({ from: dayMs(p.from), to: dayMs(p.to) });
const periodQs = (p: PartsPeriod) => `from=${dayMs(p.from)}&to=${dayMs(p.to)}`;

export function fetchAdminMonthlySummary(period?: PartsPeriod) {
  const qs = period ? `?${periodQs(period)}` : '';
  return wrap(async () => ({ rows: normalizeSummary((await api<{ rows: any[] }>(`/parts/admin-summary${qs}`)).rows) }), {
    rows: [] as MonthlySummaryRow[],
  });
}

/** One operator's month: approved produced / modified parts, their value, and what still waits for review. */
export interface OperatorProduction {
  user_id: string;
  username: string;
  produced_qty: number;
  modification_qty: number;
  total_value: number;
  pending_qty: number;
}

/** Admin: every operator's production in a period, most productive first. */
export function fetchAdminProduction(period: PartsPeriod) {
  return wrap(
    async () => ({
      rows: (await api<{ rows: any[] }>(`/parts/admin-production?${periodQs(period)}`)).rows.map(
        (r): OperatorProduction => ({
          user_id: String(r.user_id),
          username: String(r.username || ''),
          produced_qty: Number(r.produced_qty || 0),
          modification_qty: Number(r.modification_qty || 0),
          total_value: Number(r.total_value || 0),
          pending_qty: Number(r.pending_qty || 0),
        }),
      ),
    }),
    { rows: [] as OperatorProduction[] },
  );
}

export async function fetchAdminEntriesForExport(period?: PartsPeriod): Promise<any[]> {
  const out: any[] = [];
  for (let offset = 0; ; offset += 500) {
    const res = await api<{ entries: any[]; hasMore: boolean }>(`/parts/admin-export?offset=${offset}${period ? `&${periodQs(period)}` : ''}`);
    out.push(...res.entries);
    if (!res.hasMore) return out;
  }
}
