import { useEffect, useRef, useState } from 'react';
import { scopedKey } from '../lib/instance';
import { csvCell, csvDialect } from '../lib/csv';
import { get, set } from 'idb-keyval';
import { useAuth } from '../contexts/AuthContext';
import { Folder, Save, CheckCircle } from 'lucide-react';
import { HistoryRecord } from '../types';
import { api } from '../lib/api';
import i18n, { useT } from '../i18n';

/**
 * Optional local safety copy: every 10 minutes the admin PC appends new history
 * records to "Tool_Remapping_History.csv" in a folder chosen on that PC
 * (Chrome/Edge only - uses the File System Access API).
 */

const HANDLE_KEY = scopedKey('cnc-backup-dir-handle');
const CURSOR_KEY = scopedKey('cnc-backup-cursor-v2');
const LAST_DATE_KEY = scopedKey('cnc-last-backup-date');
const CSV_NAME = 'Tool_Remapping_History.csv';
const INTERVAL_MS = 10 * 60 * 1000;

interface Cursor {
  ts: number;
  id: string;
}

function readCursor(): Cursor {
  try {
    const c = JSON.parse(localStorage.getItem(CURSOR_KEY) || 'null');
    if (c && typeof c.ts === 'number') return { ts: c.ts, id: String(c.id || '') };
  } catch {
    /* ignore */
  }
  return { ts: 0, id: '' };
}

function writeCursor(c: Cursor) {
  localStorage.setItem(CURSOR_KEY, JSON.stringify(c));
}

const q = csvCell;

async function appendRecords(dirHandle: FileSystemDirectoryHandle, records: HistoryRecord[]): Promise<void> {
  if (!records.length) return;
  const fileHandle = await dirHandle.getFileHandle(CSV_NAME, { create: true });
  const existingSize = (await fileHandle.getFile()).size;
  const rows: string[] = [];
  const { sep, num } = csvDialect(i18n.language);
  if (existingSize === 0) {
    rows.push([
      i18n.t('data:csv.actionDate'), i18n.t('data:csv.user'), i18n.t('data:csv.originalFile'), i18n.t('data:csv.exportedFile'),
      i18n.t('data:csv.originalTool'), i18n.t('data:csv.originalContext'),
      i18n.t('data:csv.requestedDiameter'), i18n.t('data:csv.requestedLength'), i18n.t('data:csv.selectionType'), i18n.t('data:csv.chosenCategory'),
      i18n.t('data:csv.chosenTNumber'), i18n.t('data:csv.chosenDiameter'), i18n.t('data:csv.chosenLength')
    ].join(sep));
  }
  const unknownUser = i18n.t('data:csv.unknownUser');
  const autoLabel = i18n.t('data:csv.auto');
  const manualLabel = i18n.t('data:csv.manual');
  for (const r of records) {
    const base = [q(r.date), q(r.user || unknownUser), q(r.originalFileName), q(r.exportedFileName)];
    if (!r.changes.length) {
      rows.push([...base, ...Array(9).fill('"-"')].join(sep));
      continue;
    }
    for (const c of r.changes) {
      rows.push([
        ...base,
        q(c.originalT), q(c.originalContext || ''), q(num(c.reqDiameter || '')), q(num(c.reqLength || '')),
        q(c.appChose ? autoLabel : manualLabel), q(c.chosenCategory), q(`T${c.chosenT}`), q(num(c.chosenDiameter)), q(num(c.chosenLength)),
      ].join(sep));
    }
  }
  const writable = await fileHandle.createWritable({ keepExistingData: true });
  // A new file starts with a UTF-8 BOM so Excel shows accented and Turkish letters correctly.
  await writable.write({ type: 'write', position: existingSize, data: (existingSize > 0 ? '\n' : '\uFEFF') + rows.join('\n') });
  await writable.close();
}

/** Appends every record newer than the saved cursor. Returns how many were written. */
async function runBackup(dirHandle: FileSystemDirectoryHandle): Promise<number> {
  let cursor = readCursor();
  let written = 0;
  for (;;) {
    const qs = new URLSearchParams({ after: String(cursor.ts), afterId: cursor.id, limit: '500' });
    const page = await api<{ records: HistoryRecord[]; hasMore: boolean }>(`/history/since?${qs}`);
    if (!page.records.length) break;
    await appendRecords(dirHandle, page.records);
    written += page.records.length;
    const last = page.records[page.records.length - 1];
    cursor = { ts: last.timestamp ?? cursor.ts, id: last.id };
    writeCursor(cursor);
    if (!page.hasMore) break;
  }
  if (written) localStorage.setItem(LAST_DATE_KEY, new Date().toISOString().slice(0, 10));
  return written;
}

/** Headless instance mounted once in the app shell: performs the 10-minute automatic backup. */
export function BackupScheduler() {
  const { user } = useAuth();
  useEffect(() => {
    if (user?.role !== 'ADMIN') return;
    const tick = async () => {
      try {
        const handle = (await get(HANDLE_KEY)) as FileSystemDirectoryHandle | undefined;
        if (!handle || (await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') return;
        await runBackup(handle);
      } catch (err) {
        console.warn('Automatic folder backup skipped:', err);
      }
    };
    const id = setInterval(tick, INTERVAL_MS);
    return () => clearInterval(id);
  }, [user?.role]);
  return null;
}

export default function BackupManager() {
  const { t } = useT('data');
  const { user } = useAuth();
  const [handleInfo, setHandleInfo] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [lastBackup, setLastBackup] = useState<string | null>(() => localStorage.getItem(LAST_DATE_KEY));
  const directoryHandleRef = useRef<FileSystemDirectoryHandle | null>(null);
  const supported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

  useEffect(() => {
    get(HANDLE_KEY)
      .then(handle => {
        if (handle) {
          directoryHandleRef.current = handle as FileSystemDirectoryHandle;
          setHandleInfo((handle as FileSystemDirectoryHandle).name);
        }
      })
      .catch(err => console.error('Failed to load dir handle', err));
  }, []);

  const selectDirectory = async () => {
    setError('');
    try {
      const handle: FileSystemDirectoryHandle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
      await set(HANDLE_KEY, handle);
      directoryHandleRef.current = handle;
      setHandleInfo(handle.name);
      const fromStart = confirm(t('folder.confirmFromStart'));
      writeCursor(fromStart ? { ts: 0, id: '' } : { ts: Date.now(), id: '' });
      if (fromStart) await forceBackupNow();
    } catch (err: any) {
      if (err?.name !== 'AbortError') setError(t('folder.selectFailed', { error: String(err?.message || err) }));
    }
  };

  const forceBackupNow = async () => {
    const handle = directoryHandleRef.current;
    if (!handle) {
      setError(t('folder.noDirectory'));
      return;
    }
    setIsBusy(true);
    setError('');
    setMessage('');
    try {
      if ((await handle.queryPermission({ mode: 'readwrite' })) !== 'granted' &&
          (await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') {
        throw new Error(t('folder.permissionDenied'));
      }
      const n = await runBackup(handle);
      setLastBackup(localStorage.getItem(LAST_DATE_KEY));
      setMessage(n ? t('folder.appended', { count: n, file: CSV_NAME }) : t('folder.upToDate'));
    } catch (err: any) {
      setError(t('folder.failed', { error: String(err?.message || err) }));
    } finally {
      setIsBusy(false);
    }
  };

  if (user?.role !== 'ADMIN') return null;

  return (
    <div>
      <div className="flex items-center gap-2.5 mb-3">
        <div className="p-2 rounded-[var(--radius-md)] bg-[var(--green-500)]/15 border border-[var(--green-500)]/30 text-[var(--green-500)]">
          <Save size={18} />
        </div>
        <div>
          <h3 className="text-sm font-bold text-[var(--text-primary)]">{t('folder.title')}</h3>
          <p className="text-xs text-[var(--text-secondary)] mt-0.5">
            {t('folder.descBefore')}<code className="font-mono">{CSV_NAME}</code>{t('folder.descAfter')}
          </p>
        </div>
      </div>

      {!supported && (
        <div className="badge-warning text-xs py-2 px-3 mb-3">{t('folder.unsupported')}</div>
      )}
      {error && <div className="badge-danger text-xs py-2 px-3 mb-3 font-semibold">{error}</div>}
      {message && <div className="badge-positive text-xs py-2 px-3 mb-3">{message}</div>}

      <div className="flex items-center gap-4 flex-wrap pt-1">
        <button onClick={selectDirectory} disabled={!supported || isBusy} className="btn-secondary text-xs py-2 px-4 flex items-center gap-2">
          <Folder size={15} />
          <span>{handleInfo ? t('folder.change') : t('folder.select')}</span>
        </button>
        {handleInfo && (
          <div className="badge-positive text-xs py-1.5 px-3 flex items-center gap-1.5">
            <CheckCircle size={14} />
            <span>{t('folder.directory')} <strong className="font-mono">{handleInfo}</strong></span>
          </div>
        )}
      </div>

      {handleInfo && (
        <div className="mt-4 pt-4 border-t border-[var(--border-subtle)] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="text-[11px] text-[var(--text-tertiary)]">
            {t('folder.autoNote')}<br />
            {t('folder.lastBackup')} <span className="text-[var(--text-secondary)] font-mono">{lastBackup || t('folder.never')}</span>
          </div>
          <button onClick={forceBackupNow} disabled={isBusy} className="btn-secondary text-xs py-1.5 px-3">
            {isBusy ? t('folder.backingUp') : t('folder.forceNow')}
          </button>
        </div>
      )}
    </div>
  );
}
