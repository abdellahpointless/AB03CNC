import { get, set } from 'idb-keyval';
import { api, ApiError } from './api';
import { compressCode, decompressCode, type StoredCode } from './codeStorage';
import type { HistoryRecord } from '../types';

/**
 * Every "Extract Code" is written to a local queue (IndexedDB) first and then
 * uploaded. If the network or server is down, the export still downloads and
 * the history record is uploaded automatically once the connection is back.
 */

const OUTBOX_KEY = 'cnc-export-outbox-v1';
export const OUTBOX_EVENT = 'cnc-outbox-changed';

interface OutboxItem {
  record: HistoryRecord;
  code: StoredCode | null;
  attempts: number;
  lastError?: string;
}

let flushing: Promise<void> | null = null;

async function readOutbox(): Promise<OutboxItem[]> {
  try {
    return ((await get(OUTBOX_KEY)) as OutboxItem[] | undefined) ?? [];
  } catch {
    return [];
  }
}

async function writeOutbox(items: OutboxItem[]): Promise<void> {
  await set(OUTBOX_KEY, items);
  window.dispatchEvent(new CustomEvent(OUTBOX_EVENT, { detail: items.length }));
}

export async function getOutboxCount(): Promise<number> {
  return (await readOutbox()).length;
}

export async function submitExport(record: HistoryRecord, code: string): Promise<'saved' | 'queued'> {
  let stored: StoredCode | null = null;
  try {
    stored = await compressCode(code);
  } catch {
    stored = { encoding: 'plain', data: code, size: code.length };
  }
  const items = await readOutbox();
  items.push({ record, code: stored, attempts: 0 });
  await writeOutbox(items);
  await flushOutbox();
  const remaining = await readOutbox();
  return remaining.some((i) => i.record.id === record.id) ? 'queued' : 'saved';
}

export function flushOutbox(): Promise<void> {
  if (!flushing) {
    flushing = doFlush().finally(() => {
      flushing = null;
    });
  }
  return flushing;
}

async function doFlush(): Promise<void> {
  let items = await readOutbox();
  while (items.length) {
    const item = items[0];
    try {
      await api('/history', { method: 'POST', body: { record: item.record, code: item.code }, timeoutMs: 120_000 });
      items = (await readOutbox()).filter((i) => i.record.id !== item.record.id);
      await writeOutbox(items);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      // Network/server trouble or signed out: keep it and retry later.
      if (status === 0 || status >= 500 || status === 401 || status === 429) return;
      // The server rejected the record itself; drop it so it cannot block the queue forever.
      console.error('Dropping export that the server rejected', item.record.id, err);
      items = (await readOutbox()).filter((i) => i.record.id !== item.record.id);
      await writeOutbox(items);
    }
  }
}

const codeCache = new Map<string, string>();

/** Loads the generated program for a history record (local queue first, then the server). */
export async function fetchRecordCode(id: string): Promise<string> {
  const cached = codeCache.get(id);
  if (cached !== undefined) return cached;

  const pending = (await readOutbox()).find((i) => i.record.id === id);
  if (pending?.code) return decompressCode(pending.code);

  const stored = await api<StoredCode>(`/history/${encodeURIComponent(id)}/code`);
  const text = await decompressCode(stored);
  if (codeCache.size > 30) codeCache.delete(codeCache.keys().next().value!);
  codeCache.set(id, text);
  return text;
}

export interface HistoryPage {
  records: HistoryRecord[];
  total: number;
}

export function fetchHistoryPage(params: { limit: number; offset: number; user?: string; q?: string }): Promise<HistoryPage> {
  const qs = new URLSearchParams({ limit: String(params.limit), offset: String(params.offset) });
  if (params.user) qs.set('user', params.user);
  if (params.q) qs.set('q', params.q);
  return api<HistoryPage>(`/history?${qs}`);
}

/** Every history record (oldest first), fetched in pages. Admin only. */
export async function fetchAllHistory(onProgress?: (n: number) => void): Promise<HistoryRecord[]> {
  const all: HistoryRecord[] = [];
  let after = 0;
  let afterId = '';
  for (;;) {
    const qs = new URLSearchParams({ after: String(after), afterId, limit: '1000' });
    const page = await api<{ records: HistoryRecord[]; hasMore: boolean }>(`/history/since?${qs}`);
    all.push(...page.records);
    onProgress?.(all.length);
    if (!page.hasMore || page.records.length === 0) break;
    const last = page.records[page.records.length - 1];
    after = last.timestamp ?? after;
    afterId = last.id;
  }
  return all;
}
