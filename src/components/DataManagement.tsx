import React, { useRef, useState } from 'react';
import { DownloadCloud, UploadCloud, Archive, Trash2, RefreshCw, CheckCircle2, AlertTriangle } from 'lucide-react';
import { api } from '../lib/api';
import { buildFullBackup, restoreBackup, type LogKind } from '../lib/migration';
import { fetchAllHistory } from '../lib/historyApi';
import { downloadJson, todayStamp } from '../lib/download';
import { useSync } from '../contexts/SyncContext';
import { useT } from '../i18n';
import { locale } from '../i18n/format';

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
          <span className="text-[var(--text-tertiary)]">{new Date(l.t).toLocaleTimeString(locale())} </span>
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
  const { t } = useT('data');
  const { refreshNow } = useSync();
  const [busy, setBusy] = useState<string | null>(null);

  // Backup / restore
  const [includePrograms, setIncludePrograms] = useState(false);
  const [replaceTools, setReplaceTools] = useState(false);
  const backupLog = useLog();
  const fileRef = useRef<HTMLInputElement>(null);

  // Retention
  const [pruneDays, setPruneDays] = useState(90);
  const retentionLog = useLog();

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
      backupLog.log(t('backup.reading', { name: file.name, size: Math.round(file.size / 1024) }));
      const data = JSON.parse(await file.text());
      await restoreBackup(data, { replaceTools }, backupLog.log);
      await refreshNow();
    } catch (err: any) {
      backupLog.log(err instanceof SyntaxError ? t('backup.invalidJson') : err?.message || String(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const pruneHistory = async () => {
    const days = Math.round(pruneDays);
    if (!(days >= 1)) return;
    if (!confirm(t('retention.confirmPrune', { days }))) return;
    retentionLog.clear();
    setBusy('prune');
    try {
      const cutoff = Date.now() - days * 86_400_000;
      const old = (await fetchAllHistory()).filter(r => (r.timestamp ?? 0) < cutoff);
      if (!old.length) {
        retentionLog.log(t('retention.noneOlder', { days }), 'info');
        return;
      }
      downloadJson(`CNC_History_Archive_${todayStamp()}.json`, { archivedAt: new Date().toISOString(), history: [...old].reverse() });
      const res = await api<{ deleted: number }>('/history/prune', { method: 'POST', body: { olderThanDays: days } });
      retentionLog.log(t('retention.removed', { count: res.deleted }), 'ok');
    } catch (err: any) {
      retentionLog.log(err?.message || String(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const clearAllHistory = async () => {
    if (!confirm(t('retention.confirmClearAll'))) return;
    const word = t('retention.deleteWord');
    if (prompt(t('retention.typeToConfirm', { word })) !== word) return;
    retentionLog.clear();
    setBusy('clear');
    try {
      const all = await fetchAllHistory();
      downloadJson(`CNC_History_Archive_Full_${todayStamp()}.json`, { archivedAt: new Date().toISOString(), history: [...all].reverse() });
      const res = await api<{ deleted: number }>('/history', { method: 'DELETE' });
      retentionLog.log(t('retention.removed', { count: res.deleted }), 'ok');
    } catch (err: any) {
      retentionLog.log(err?.message || String(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Backup & restore */}
      <div>
        <div className="flex items-center gap-2.5 mb-3">
          <div className="p-2 rounded-[var(--radius-md)] bg-[var(--green-500)]/15 border border-[var(--green-500)]/30 text-[var(--green-500)]">
            <Archive size={18} />
          </div>
          <div>
            <h3 className="text-sm font-bold text-[var(--text-primary)]">{t('backup.title')}</h3>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">
              {t('backup.descBefore')}<code className="font-mono">CNC_Studio_Backup_*.json</code>,{' '}
              <code className="font-mono">CNC_History_Archive_*.json</code>{t('backup.descAfter')}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={downloadBackup} disabled={busy !== null} className="btn-secondary text-xs py-2 px-4">
            {busy === 'backup' ? <RefreshCw size={14} className="animate-spin" /> : <DownloadCloud size={14} />}
            <span>{t('backup.download')}</span>
          </button>
          <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer select-none">
            <input type="checkbox" checked={includePrograms} onChange={e => setIncludePrograms(e.target.checked)} disabled={busy !== null} />
            {t('backup.includePrograms')}
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3 mt-3">
          <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={onRestoreFile} />
          <button onClick={() => fileRef.current?.click()} disabled={busy !== null} className="btn-secondary text-xs py-2 px-4">
            {busy === 'restore' ? <RefreshCw size={14} className="animate-spin" /> : <UploadCloud size={14} />}
            <span>{t('backup.restore')}</span>
          </button>
          <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer select-none">
            <input type="checkbox" checked={replaceTools} onChange={e => setReplaceTools(e.target.checked)} disabled={busy !== null} />
            {t('backup.replaceTools')}
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
            <h3 className="text-sm font-bold text-[var(--text-primary)]">{t('retention.title')}</h3>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">
              {t('retention.description')}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-[var(--text-secondary)]">{t('retention.olderThan')}</span>
          <input
            type="number"
            min={1}
            max={3650}
            value={pruneDays}
            onChange={e => setPruneDays(Number(e.target.value))}
            aria-label={`${t('retention.olderThan')} (${t('retention.days')})`}
            className="aurora-input w-20 text-xs py-1.5"
            disabled={busy !== null}
          />
          <span className="text-xs text-[var(--text-secondary)]">{t('retention.days')}</span>
          <button onClick={pruneHistory} disabled={busy !== null || !(pruneDays >= 1)} className="btn-secondary text-xs py-1.5 px-3">
            <Archive size={13} />
            <span>{t('retention.archiveDelete')}</span>
          </button>
          <button onClick={clearAllHistory} disabled={busy !== null} className="btn-danger text-xs py-1.5 px-3">
            <Trash2 size={13} />
            <span>{t('retention.clearAll')}</span>
          </button>
        </div>
        <LogView lines={retentionLog.lines} />
        {retentionLog.lines.some(l => l.kind === 'ok') && (
          <div className="mt-2 text-[11px] text-[var(--green-500)] flex items-center gap-1">
            <CheckCircle2 size={12} /> {t('retention.done')}
          </div>
        )}
      </div>
    </div>
  );
}
