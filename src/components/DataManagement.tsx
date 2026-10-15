import React, { useRef, useState } from 'react';
import { Database, DownloadCloud, UploadCloud, Archive, Trash2, RefreshCw, CheckCircle2, AlertTriangle, Info } from 'lucide-react';
import { api } from '../lib/api';
import { buildFullBackup, migrateFromSupabase, restoreBackup, type LogKind, type MigrationOptions } from '../lib/migration';
import { fetchAllHistory } from '../lib/historyApi';
import { downloadJson, todayStamp } from '../lib/download';
import { useSync } from '../contexts/SyncContext';

interface LogLine {
  t: number;
  kind: LogKind;
  text: string;
}

function LogView({ lines }: { lines: LogLine[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  React.useEffect(() => endRef.current?.scrollIntoView({ block: 'nearest' }), [lines.length]);
  if (!lines.length) return null;
  const color: Record<LogKind, string> = {
    info: 'text-[var(--text-secondary)]',
    ok: 'text-[var(--green-500)]',
    warn: 'text-[var(--orange-500)]',
    error: 'text-[var(--rose-500)]',
  };
  return (
    <div className="mt-3 max-h-56 overflow-y-auto rounded-[var(--radius-md)] bg-[var(--bg-input)] border border-[var(--border-subtle)] p-3 font-mono text-[11px] space-y-0.5">
      {lines.map((l, i) => (
        <div key={i} className={color[l.kind]}>
          <span className="text-[var(--text-tertiary)]">{new Date(l.t).toLocaleTimeString()} </span>
          {l.text}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

function useLog() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const log = (text: string, kind: LogKind = 'info') => setLines(prev => [...prev.slice(-300), { t: Date.now(), kind, text }]);
  return { lines, log, clear: () => setLines([]) };
}

export default function DataManagement() {
  const { refreshNow } = useSync();
  const [busy, setBusy] = useState<string | null>(null);

  // Supabase migration
  const [sbUrl, setSbUrl] = useState('');
  const [sbKey, setSbKey] = useState('');
  const [opts, setOpts] = useState<MigrationOptions>({ users: true, tools: true, history: true, programs: true, parts: true });
  const migrationLog = useLog();

  // Backup / restore
  const [includePrograms, setIncludePrograms] = useState(false);
  const [replaceTools, setReplaceTools] = useState(false);
  const backupLog = useLog();
  const fileRef = useRef<HTMLInputElement>(null);

  // Retention
  const [pruneDays, setPruneDays] = useState(90);
  const retentionLog = useLog();

  const runMigration = async () => {
    if (!confirm('Copy all data from Supabase into this Cloudflare installation?\n\nExisting records are kept; nothing is deleted except that the tool inventory is replaced by the one from Supabase.')) return;
    migrationLog.clear();
    setBusy('migrate');
    try {
      const s = await migrateFromSupabase({ url: sbUrl, anonKey: sbKey }, opts, migrationLog.log);
      migrationLog.log(
        `Done: ${s.users} new account(s), ${s.tools} tools, ${s.history} history records, ${s.programs} program files, ${s.parts} part entries.`,
        'ok',
      );
      await refreshNow();
    } catch (err: any) {
      migrationLog.log(err?.message || String(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const downloadBackup = async () => {
    backupLog.clear();
    setBusy('backup');
    try {
      const data = await buildFullBackup(includePrograms, backupLog.log);
      downloadJson(`CNC_Process_Pro_Backup_${todayStamp()}.json`, data);
    } catch (err: any) {
      backupLog.log(err?.message || String(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const onRestoreFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    backupLog.clear();
    setBusy('restore');
    try {
      backupLog.log(`Reading ${file.name} (${Math.round(file.size / 1024)} KB)...`);
      const data = JSON.parse(await file.text());
      await restoreBackup(data, { replaceTools }, backupLog.log);
      await refreshNow();
    } catch (err: any) {
      backupLog.log(err instanceof SyntaxError ? 'This file is not valid JSON.' : err?.message || String(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const pruneHistory = async () => {
    const days = Math.round(pruneDays);
    if (!(days >= 1)) return;
    if (!confirm(`Delete history records (and their stored G-code files) older than ${days} days?\n\nA JSON archive of the deleted records is downloaded first.`)) return;
    retentionLog.clear();
    setBusy('prune');
    try {
      const cutoff = Date.now() - days * 86_400_000;
      const old = (await fetchAllHistory()).filter(r => (r.timestamp ?? 0) < cutoff);
      if (!old.length) {
        retentionLog.log(`No records older than ${days} days.`, 'info');
        return;
      }
      downloadJson(`CNC_History_Archive_${todayStamp()}.json`, { archivedAt: new Date().toISOString(), history: [...old].reverse() });
      const res = await api<{ deleted: number }>('/history/prune', { method: 'POST', body: { olderThanDays: days } });
      retentionLog.log(`Archive downloaded, ${res.deleted} record(s) removed.`, 'ok');
    } catch (err: any) {
      retentionLog.log(err?.message || String(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const clearAllHistory = async () => {
    if (!confirm('Delete ALL history records and stored G-code files?\n\nA full JSON archive is downloaded first. The "time won" counter is not reset.')) return;
    if (prompt('Type DELETE to confirm') !== 'DELETE') return;
    retentionLog.clear();
    setBusy('clear');
    try {
      const all = await fetchAllHistory();
      downloadJson(`CNC_History_Archive_Full_${todayStamp()}.json`, { archivedAt: new Date().toISOString(), history: [...all].reverse() });
      const res = await api<{ deleted: number }>('/history', { method: 'DELETE' });
      retentionLog.log(`Archive downloaded, ${res.deleted} record(s) removed.`, 'ok');
    } catch (err: any) {
      retentionLog.log(err?.message || String(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const check = (key: keyof MigrationOptions, label: string) => (
    <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer select-none">
      <input type="checkbox" checked={opts[key]} onChange={e => setOpts(o => ({ ...o, [key]: e.target.checked }))} disabled={busy !== null} />
      {label}
    </label>
  );

  return (
    <div className="space-y-6">
      {/* Supabase migration */}
      <div>
        <div className="flex items-center gap-2.5 mb-3">
          <div className="p-2 rounded-[var(--radius-md)] bg-[var(--blue-500)]/15 border border-[var(--blue-500)]/30 text-[var(--blue-500)]">
            <Database size={18} />
          </div>
          <div>
            <h3 className="text-sm font-bold text-[var(--text-primary)]">Import from Supabase (one-time migration)</h3>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">
              Copies accounts, tool inventory, history, generated programs and part entries from the old Supabase project.
              Safe to run more than once - records that already exist are skipped.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="section-label block mb-1">Supabase project URL</label>
            <input className="aurora-input w-full text-xs font-mono" placeholder="https://xxxxxxxx.supabase.co" value={sbUrl} onChange={e => setSbUrl(e.target.value)} disabled={busy !== null} />
          </div>
          <div>
            <label className="section-label block mb-1">Supabase anon key</label>
            <input type="password" className="aurora-input w-full text-xs font-mono" placeholder="eyJhbGciOi..." value={sbKey} onChange={e => setSbKey(e.target.value)} disabled={busy !== null} autoComplete="off" />
          </div>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2 mt-3">
          {check('users', 'Accounts')}
          {check('tools', 'Tool inventory (replaces current)')}
          {check('history', 'History')}
          {check('programs', 'Generated G-code files')}
          {check('parts', 'Part entries')}
        </div>
        <div className="mt-3 flex items-center gap-3 flex-wrap">
          <button onClick={runMigration} disabled={busy !== null || !sbUrl || !sbKey} className="btn-primary text-xs py-2 px-4">
            {busy === 'migrate' ? <RefreshCw size={14} className="animate-spin" /> : <DownloadCloud size={14} />}
            <span>{busy === 'migrate' ? 'Importing...' : 'Start import'}</span>
          </button>
          <span className="text-[11px] text-[var(--text-tertiary)] flex items-center gap-1">
            <Info size={12} /> Keep this tab open until it says "Migration finished".
          </span>
        </div>
        <LogView lines={migrationLog.lines} />
      </div>

      <div className="border-t border-[var(--border-subtle)]" />

      {/* Backup & restore */}
      <div>
        <div className="flex items-center gap-2.5 mb-3">
          <div className="p-2 rounded-[var(--radius-md)] bg-[var(--green-500)]/15 border border-[var(--green-500)]/30 text-[var(--green-500)]">
            <Archive size={18} />
          </div>
          <div>
            <h3 className="text-sm font-bold text-[var(--text-primary)]">Backup &amp; restore</h3>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">
              Download everything as one JSON file, or restore one. Old-version files (<code className="font-mono">CNC_Studio_Backup_*.json</code>,{' '}
              <code className="font-mono">CNC_History_Archive_*.json</code>) can be imported too, to bring back archived history.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={downloadBackup} disabled={busy !== null} className="btn-secondary text-xs py-2 px-4">
            {busy === 'backup' ? <RefreshCw size={14} className="animate-spin" /> : <DownloadCloud size={14} />}
            <span>Download full backup</span>
          </button>
          <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer select-none">
            <input type="checkbox" checked={includePrograms} onChange={e => setIncludePrograms(e.target.checked)} disabled={busy !== null} />
            Include G-code files (bigger file)
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3 mt-3">
          <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={onRestoreFile} />
          <button onClick={() => fileRef.current?.click()} disabled={busy !== null} className="btn-secondary text-xs py-2 px-4">
            {busy === 'restore' ? <RefreshCw size={14} className="animate-spin" /> : <UploadCloud size={14} />}
            <span>Restore / import a backup file...</span>
          </button>
          <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer select-none">
            <input type="checkbox" checked={replaceTools} onChange={e => setReplaceTools(e.target.checked)} disabled={busy !== null} />
            Replace tool inventory with the one in the file
          </label>
        </div>
        <LogView lines={backupLog.lines} />
      </div>

      <div className="border-t border-[var(--border-subtle)]" />

      {/* Retention */}
      <div>
        <div className="flex items-center gap-2.5 mb-3">
          <div className="p-2 rounded-[var(--radius-md)] bg-[var(--orange-500)]/15 border border-[var(--orange-500)]/30 text-[var(--orange-500)]">
            <AlertTriangle size={18} />
          </div>
          <div>
            <h3 className="text-sm font-bold text-[var(--text-primary)]">History clean-up (optional)</h3>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">
              History no longer blocks operators after 30 days. The free database holds years of records, so cleaning up is only needed if you want to.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-[var(--text-secondary)]">Delete records older than</span>
          <input
            type="number"
            min={1}
            max={3650}
            value={pruneDays}
            onChange={e => setPruneDays(Number(e.target.value))}
            className="aurora-input w-20 text-xs py-1.5"
            disabled={busy !== null}
          />
          <span className="text-xs text-[var(--text-secondary)]">days</span>
          <button onClick={pruneHistory} disabled={busy !== null || !(pruneDays >= 1)} className="btn-secondary text-xs py-1.5 px-3">
            <Archive size={13} />
            <span>Archive &amp; delete</span>
          </button>
          <button onClick={clearAllHistory} disabled={busy !== null} className="btn-danger text-xs py-1.5 px-3">
            <Trash2 size={13} />
            <span>Clear all history</span>
          </button>
        </div>
        <LogView lines={retentionLog.lines} />
        {retentionLog.lines.some(l => l.kind === 'ok') && (
          <div className="mt-2 text-[11px] text-[var(--green-500)] flex items-center gap-1">
            <CheckCircle2 size={12} /> Done
          </div>
        )}
      </div>
    </div>
  );
}
