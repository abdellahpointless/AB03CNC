import i18n from '../i18n';
import { api } from './api';
import { currentRegion } from './instance';
import { compressCode, type StoredCode } from './codeStorage';
import { fetchAllHistory } from './historyApi';
import type { HistoryRecord, MachineToolbox } from '../types';

export type LogKind = 'info' | 'ok' | 'warn' | 'error';
export type Logger = (message: string, kind?: LogKind) => void;

export interface ImportSummary {
  users: number;
  tools: number;
  history: number;
  programs: number;
  parts: number;
}

const HISTORY_BATCH = 100;
const PARTS_BATCH = 300;
const USERS_BATCH = 3;

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

// ---- Server-side import helpers (used by backup restore) ----

async function importUsers(users: any[], log: Logger): Promise<{ idMap: Record<string, string>; created: number }> {
  const idMap: Record<string, string> = {};
  let created = 0;
  for (const batch of chunk(users, USERS_BATCH)) {
    const res = await api<{ idMap: Record<string, string>; created: string[]; skipped: string[] }>('/admin/import/users', {
      method: 'POST',
      body: { users: batch },
    });
    Object.assign(idMap, res.idMap);
    created += res.created.length;
    if (res.created.length) log(i18n.t('data:log.createdAccounts', { names: res.created.join(', ') }), 'ok');
    if (res.skipped.length) log(i18n.t('data:log.keptAccounts', { names: res.skipped.join(', ') }), 'info');
  }
  return { idMap, created };
}

async function importToolbox(toolbox: MachineToolbox, mode: 'replace' | 'merge'): Promise<number> {
  const res = await api<{ count: number }>('/admin/import/tools', { method: 'POST', body: { toolbox, mode } });
  return res.count;
}

async function importHistory(
  records: any[],
  log: Logger,
  codes?: Record<string, StoredCode>,
): Promise<number> {
  let inserted = 0;
  const batches = chunk(records, HISTORY_BATCH);
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const batchCodes: Record<string, StoredCode> = {};
    if (codes) for (const r of batch) if (codes[r.id]) batchCodes[r.id] = codes[r.id];
    const res = await api<{ inserted: number; skipped: number }>('/admin/import/history', {
      method: 'POST',
      body: { records: batch, codes: batchCodes },
      timeoutMs: 120_000,
    });
    inserted += res.inserted;
    log(i18n.t('data:log.historyProgress', { done: Math.min((b + 1) * HISTORY_BATCH, records.length), total: records.length }), 'info');
  }
  return inserted;
}

async function importParts(entries: any[], idMap: Record<string, string>, log: Logger): Promise<number> {
  let inserted = 0;
  for (const batch of chunk(entries, PARTS_BATCH)) {
    const res = await api<{ inserted: number }>('/admin/import/parts', { method: 'POST', body: { entries: batch, idMap } });
    inserted += res.inserted;
  }
  if (entries.length) log(i18n.t('data:log.partsImported', { inserted, total: entries.length }), 'ok');
  return inserted;
}

async function attachProgram(recordId: string, codeText: string): Promise<boolean> {
  const code = await compressCode(codeText);
  const res = await api<{ ok: boolean }>('/admin/import/code', { method: 'POST', body: { id: recordId, code }, timeoutMs: 120_000 });
  return res.ok;
}

// ---- Backup / restore -------------------------------------------------------------

export const BACKUP_FORMAT = 'cnc-process-pro-backup';

export async function buildFullBackup(includePrograms: boolean, log: Logger) {
  log(i18n.t('data:log.downloadingTools'));
  const { toolbox } = await api<{ toolbox: MachineToolbox }>('/tools');
  log(i18n.t('data:log.downloadingAccounts'));
  const { users } = await api<{ users: any[] }>('/users');
  log(i18n.t('data:log.downloadingHistory'));
  const history = await fetchAllHistory(n => log(i18n.t('data:log.historyCount', { count: n })));
  const partEntries: any[] = [];
  if (currentRegion().features.partTracking) log(i18n.t('data:log.downloadingParts'));
  for (let offset = 0; currentRegion().features.partTracking; offset += 500) {
    const res = await api<{ entries: any[]; hasMore: boolean }>(`/parts/admin-export?offset=${offset}`);
    partEntries.push(...res.entries);
    if (!res.hasMore) break;
  }
  const analytics = await api<{ savedSecondsPerExtraction: number }>('/analytics');

  const programs: Record<string, StoredCode> = {};
  if (includePrograms) {
    const withCode = history.filter(h => h.hasCode);
    let n = 0;
    await mapLimit(withCode, 4, async rec => {
      try {
        programs[rec.id] = await api<StoredCode>(`/history/${encodeURIComponent(rec.id)}/code`);
      } catch {
        /* missing file - skip */
      }
      if (++n % 25 === 0) log(i18n.t('data:log.programsCount', { done: n, total: withCode.length }));
    });
  }

  log(i18n.t('data:log.backupReady'), 'ok');
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    note: 'Passwords are not included. Accounts must be re-created (or kept) on the target installation.',
    users,
    toolbox,
    history: [...history].reverse(),
    partEntries,
    settings: { savedSecondsPerExtraction: analytics.savedSecondsPerExtraction },
    programs: includePrograms ? programs : undefined,
  };
}

/**
 * Restores a backup made by this app, or imports the JSON files made by the
 * old version ("CNC_Studio_Backup_*.json", "CNC_History_Archive_*.json").
 * History and part entries are merged (nothing is duplicated or deleted).
 */
export async function restoreBackup(data: any, opts: { replaceTools: boolean }, log: Logger): Promise<ImportSummary> {
  if (!data || typeof data !== 'object') throw new Error(i18n.t('data:errors.notBackup'));
  const summary: ImportSummary = { users: 0, tools: 0, history: 0, programs: 0, parts: 0 };
  const isNew = data.format === BACKUP_FORMAT;
  const history: any[] = Array.isArray(data.history) ? data.history : [];
  if (!history.length && !data.toolbox && !Array.isArray(data.partEntries)) {
    throw new Error(i18n.t('data:errors.emptyBackup'));
  }

  if (data.toolbox && typeof data.toolbox === 'object') {
    if (opts.replaceTools) {
      summary.tools = await importToolbox(data.toolbox, 'replace');
      log(i18n.t('data:log.toolsReplaced', { count: summary.tools }), 'ok');
    } else {
      log(i18n.t('data:log.toolsSkipped'), 'info');
    }
  }

  if (history.length) {
    log(i18n.t('data:log.importingHistory', { count: history.length }));
    summary.history = await importHistory(history, log, isNew ? data.programs : undefined);
    if (isNew && data.programs) summary.programs = Object.keys(data.programs).length;
    log(i18n.t('data:log.historyRestored', { added: summary.history, present: history.length - summary.history }), 'ok');
  }

  if (isNew && Array.isArray(data.partEntries) && data.partEntries.length && currentRegion().features.partTracking) {
    const { users } = await api<{ users: { id: string; username: string }[] }>('/users');
    // Map entries to current accounts by username when the ids differ.
    const byName = new Map(users.map(u => [u.username.toLowerCase(), u.id]));
    const idMap: Record<string, string> = {};
    for (const e of data.partEntries) {
      const id = byName.get(String(e.username || '').toLowerCase());
      if (id && e.user_id && e.user_id !== id) idMap[e.user_id] = id;
    }
    summary.parts = await importParts(data.partEntries, idMap, log);
  }

  if (isNew && data.settings?.savedSecondsPerExtraction) {
    await api('/admin/import/settings', { method: 'POST', body: { savedSecondsPerExtraction: data.settings.savedSecondsPerExtraction } });
  }

  log(i18n.t('data:log.restoreFinished'), 'ok');
  return summary;
}
