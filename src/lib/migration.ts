import { api } from './api';
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

function extractCodeText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const v = value as Record<string, any>;
    if (typeof v.code === 'string') return v.code;
    if (typeof v.value === 'string') return v.value;
    if (typeof v.value?.code === 'string') return v.value.code;
  }
  return null;
}

// ---- Server-side import helpers (shared by Supabase migration and backup restore) ----

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
    if (res.created.length) log(`Created account(s): ${res.created.join(', ')}`, 'ok');
    if (res.skipped.length) log(`Already present, kept as is: ${res.skipped.join(', ')}`, 'info');
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
    log(`History: ${Math.min((b + 1) * HISTORY_BATCH, records.length)}/${records.length} processed`, 'info');
  }
  return inserted;
}

async function importParts(entries: any[], idMap: Record<string, string>, log: Logger): Promise<number> {
  let inserted = 0;
  for (const batch of chunk(entries, PARTS_BATCH)) {
    const res = await api<{ inserted: number }>('/admin/import/parts', { method: 'POST', body: { entries: batch, idMap } });
    inserted += res.inserted;
  }
  if (entries.length) log(`Part entries: ${inserted} new of ${entries.length}`, 'ok');
  return inserted;
}

async function attachProgram(recordId: string, codeText: string): Promise<boolean> {
  const code = await compressCode(codeText);
  const res = await api<{ ok: boolean }>('/admin/import/code', { method: 'POST', body: { id: recordId, code }, timeoutMs: 120_000 });
  return res.ok;
}

// ---- Supabase -> Cloudflare migration ------------------------------------------

export interface SupabaseSource {
  url: string;
  anonKey: string;
}

export interface MigrationOptions {
  users: boolean;
  tools: boolean;
  history: boolean;
  programs: boolean;
  parts: boolean;
}

function normalizeSupabaseUrl(raw: string): string {
  const url = raw.trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(url)) {
    throw new Error('The Supabase URL should look like https://xxxxxxxx.supabase.co');
  }
  return url;
}

async function sbGet<T = any>(src: SupabaseSource, path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${src.url}/rest/v1/${path}`, {
      headers: { apikey: src.anonKey, Authorization: `Bearer ${src.anonKey}`, Accept: 'application/json' },
    });
  } catch {
    throw new Error('Could not reach Supabase from this browser (network blocked or project paused).');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase ${res.status} on ${path.split('?')[0]}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/** Reads every row of a table, page by page. */
async function sbAll<T = any>(src: SupabaseSource, table: string, select: string, order: string, pageSize = 1000): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const rows = await sbGet<T[]>(src, `${table}?select=${select}&order=${order}&limit=${pageSize}&offset=${offset}`);
    out.push(...rows);
    if (rows.length < pageSize) return out;
  }
}

async function sbOptional<T>(fn: () => Promise<T>, fallback: T, log: Logger, what: string): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    log(`${what}: ${err?.message || err} (skipped)`, 'warn');
    return fallback;
  }
}

export async function migrateFromSupabase(rawSrc: SupabaseSource, options: MigrationOptions, log: Logger): Promise<ImportSummary> {
  const src = { url: normalizeSupabaseUrl(rawSrc.url), anonKey: rawSrc.anonKey.trim() };
  if (!src.anonKey) throw new Error('Paste the Supabase anon key');
  const summary: ImportSummary = { users: 0, tools: 0, history: 0, programs: 0, parts: 0 };

  log('Connecting to Supabase...');
  const stateKeys = await sbGet<{ key: string }[]>(src, 'cnc_app_state?select=key&limit=10000');
  log(`Connected. Found ${stateKeys.length} saved app-state entries.`, 'ok');
  const keySet = new Set(stateKeys.map(k => k.key));
  const stateValue = async (key: string): Promise<any> => {
    if (!keySet.has(key)) return null;
    const rows = await sbGet<{ value: any }[]>(src, `cnc_app_state?select=value&key=eq.${encodeURIComponent(key)}`);
    return rows[0]?.value ?? null;
  };

  // 1. Accounts
  let idMap: Record<string, string> = {};
  if (options.users) {
    log('Reading user accounts...');
    const dbUsers = await sbOptional(() => sbAll<any>(src, 'app_users', '*', 'username.asc'), [], log, 'app_users');
    const localUsers = (await sbOptional(() => stateValue('cnc-mock-users'), null, log, 'local user list')) as any[] | null;
    const byName = new Map<string, any>();
    for (const u of dbUsers) if (u?.username) byName.set(String(u.username).toLowerCase(), u);
    for (const u of Array.isArray(localUsers) ? localUsers : []) {
      if (u?.username && !byName.has(String(u.username).toLowerCase())) byName.set(String(u.username).toLowerCase(), u);
    }
    const users = [...byName.values()].map(u => ({
      id: u.id,
      username: u.username,
      password: u.password,
      role: u.role,
      created_at: u.created_at,
    }));
    log(`Found ${users.length} account(s).`);
    const res = await importUsers(users, log);
    idMap = res.idMap;
    summary.users = res.created;
  }

  // 2. Tool inventory
  if (options.tools) {
    log('Reading tool inventory...');
    const toolbox = await sbOptional(() => stateValue('cnc-toolbox-v5'), null, log, 'tool inventory');
    if (toolbox && typeof toolbox === 'object') {
      summary.tools = await importToolbox(toolbox as MachineToolbox, 'replace');
      log(`Tool inventory imported: ${summary.tools} tools on ${Object.keys(toolbox).length} machines.`, 'ok');
    } else {
      log('No saved tool inventory found in Supabase - keeping the default inventory.', 'warn');
    }
  }

  // 3. History
  let history: HistoryRecord[] = [];
  if (options.history || options.programs) {
    log('Reading program history...');
    const h = await sbOptional(() => stateValue('cnc-history-v1'), null, log, 'history');
    history = Array.isArray(h) ? h : [];
  }
  if (options.history) {
    log(`Found ${history.length} history record(s).`);
    summary.history = await importHistory(history, log);
    log(`History imported: ${summary.history} new record(s).`, 'ok');
  }

  // 4. Generated program files
  if (options.programs) {
    log('Copying generated G-code files (this can take a minute)...');
    let done = 0;
    let missing = 0;
    const handle = async (recordId: string, value: unknown) => {
      const text = extractCodeText(value);
      if (!text) return;
      try {
        if (await attachProgram(recordId, text)) done++;
        else missing++;
      } catch (err: any) {
        log(`Program ${recordId}: ${err?.message || err}`, 'warn');
      }
    };
    const files = await sbOptional(
      async () => {
        const ids = await sbAll<{ id: string }>(src, 'cnc_code_files', 'id', 'id.asc');
        return ids.map(r => r.id);
      },
      [] as string[],
      log,
      'cnc_code_files',
    );
    for (const group of chunk(files, 20)) {
      const filter = `id=in.(${group.map(id => `"${id.replace(/"/g, '')}"`).join(',')})`;
      const rows = await sbOptional(() => sbGet<{ id: string; value: any }[]>(src, `cnc_code_files?select=id,value&${filter}`), [], log, 'program files');
      await mapLimit(rows, 3, r => handle(r.id.replace(/^code-/, ''), r.value));
      log(`Programs: ${done} copied so far...`, 'info');
    }
    // Very old versions stored programs inside cnc_app_state as "code-<id>"
    const legacy = [...keySet].filter(k => k.startsWith('code-'));
    await mapLimit(legacy, 3, async key => handle(key.slice(5), await stateValue(key)));
    summary.programs = done;
    log(`Program files copied: ${done}${missing ? ` (${missing} had no matching history record)` : ''}.`, 'ok');
  }

  // 5. Part entries
  if (options.parts) {
    log('Reading part entries...');
    const entries = await sbOptional(() => sbAll<any>(src, 'part_entries', '*', 'created_at.asc'), [], log, 'part_entries');
    log(`Found ${entries.length} part entr${entries.length === 1 ? 'y' : 'ies'}.`);
    summary.parts = await importParts(entries, idMap, log);
  }

  log('Migration finished.', 'ok');
  return summary;
}

// ---- Backup / restore -------------------------------------------------------------

export const BACKUP_FORMAT = 'cnc-process-pro-backup';

export async function buildFullBackup(includePrograms: boolean, log: Logger) {
  log('Downloading tool inventory...');
  const { toolbox } = await api<{ toolbox: MachineToolbox }>('/tools');
  log('Downloading accounts...');
  const { users } = await api<{ users: any[] }>('/users');
  log('Downloading history...');
  const history = await fetchAllHistory(n => log(`History: ${n} records...`));
  log('Downloading part entries...');
  const partEntries: any[] = [];
  for (let offset = 0; ; offset += 500) {
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
      if (++n % 25 === 0) log(`Programs: ${n}/${withCode.length}...`);
    });
  }

  log('Backup ready.', 'ok');
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
  if (!data || typeof data !== 'object') throw new Error('This file is not a CNC Process Pro backup');
  const summary: ImportSummary = { users: 0, tools: 0, history: 0, programs: 0, parts: 0 };
  const isNew = data.format === BACKUP_FORMAT;
  const history: any[] = Array.isArray(data.history) ? data.history : [];
  if (!history.length && !data.toolbox && !Array.isArray(data.partEntries)) {
    throw new Error('No history, tools or part entries found in this file');
  }

  if (data.toolbox && typeof data.toolbox === 'object') {
    if (opts.replaceTools) {
      summary.tools = await importToolbox(data.toolbox, 'replace');
      log(`Tool inventory replaced: ${summary.tools} tools.`, 'ok');
    } else {
      log('Tool inventory in the file was skipped (tick "Replace tool inventory" to restore it).', 'info');
    }
  }

  if (history.length) {
    log(`Importing ${history.length} history record(s)...`);
    summary.history = await importHistory(history, log, isNew ? data.programs : undefined);
    if (isNew && data.programs) summary.programs = Object.keys(data.programs).length;
    log(`History: ${summary.history} new record(s) added, ${history.length - summary.history} already present.`, 'ok');
  }

  if (isNew && Array.isArray(data.partEntries) && data.partEntries.length) {
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

  log('Restore finished.', 'ok');
  return summary;
}
