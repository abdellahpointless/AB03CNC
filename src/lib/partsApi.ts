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

export function fetchAdminMonthlySummary(monthFilter?: string) {
  const qs = monthFilter ? `?month=${encodeURIComponent(monthFilter)}` : '';
  return wrap(async () => ({ rows: normalizeSummary((await api<{ rows: any[] }>(`/parts/admin-summary${qs}`)).rows) }), {
    rows: [] as MonthlySummaryRow[],
  });
}

export async function fetchAdminEntriesForExport(monthFilter?: string): Promise<any[]> {
  const out: any[] = [];
  for (let offset = 0; ; offset += 500) {
    const qs = new URLSearchParams({ offset: String(offset) });
    if (monthFilter) qs.set('month', monthFilter);
    const res = await api<{ entries: any[]; hasMore: boolean }>(`/parts/admin-export?${qs}`);
    out.push(...res.entries);
    if (!res.hasMore) return out;
  }
}
