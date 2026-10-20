import { useEffect, useRef, useState } from 'react';
import { Cloud, CloudOff, RefreshCw, UploadCloud } from 'lucide-react';
import { useSync } from '../contexts/SyncContext';
import { AnimatePresence, motion } from 'motion/react';
import { iosMenu } from '../lib/motion';
import i18n, { useT } from '../i18n';

function ago(ts: number | null): string {
  if (!ts) return i18n.t('common:time.never');
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return i18n.t('common:time.justNow');
  if (s < 60) return i18n.t('history:sync.secondsAgo', { count: s });
  const m = Math.round(s / 60);
  return m < 60 ? i18n.t('common:time.minutesAgo', { count: m }) : i18n.t('common:time.hoursAgo', { count: Math.round(m / 60) });
}

/** Header pill: shows whether this PC is in sync with the server and whether exports are waiting to upload. */
export function SyncStatus() {
  const { t } = useT('history');
  const { connection, lastSyncAt, pendingUploads, refreshNow } = useSync();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [, forceTick] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => forceTick(n => n + 1), 5000);
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => {
      clearInterval(t);
      document.removeEventListener('mousedown', onDoc);
    };
  }, [open]);

  const retry = async () => {
    setBusy(true);
    await refreshNow();
    setBusy(false);
  };

  const state =
    connection === 'offline'
      ? { cls: 'badge-warning', dot: 'bg-[var(--orange-500)]', icon: <CloudOff size={14} className="shrink-0" />, label: t('common:status.offline') }
      : connection === 'connecting'
        ? { cls: 'badge-neutral', dot: '', icon: <RefreshCw size={14} className="animate-spin shrink-0" />, label: t('sync.connectingEllipsis') }
        : pendingUploads > 0
          ? { cls: 'badge-warning', dot: 'bg-[var(--orange-500)]', icon: <UploadCloud size={14} className="shrink-0" />, label: t('sync.toUpload', { count: pendingUploads }) }
          : { cls: 'badge-positive', dot: 'bg-[var(--green-500)] shadow-[0_0_6px_var(--green-glow)]', icon: <Cloud size={14} className="shrink-0" />, label: t('sync.synced') };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className={`${state.cls} py-1 px-3 cursor-pointer select-none shrink-0 min-w-[96px] justify-center`}
        title={t('sync.buttonTitle')}
      >
        {state.dot && <span className={`w-2 h-2 rounded-full shrink-0 ${state.dot}`} />}
        {state.icon}
        <span className="hidden md:inline">{state.label}</span>
      </button>

      <AnimatePresence>
      {open && (
        <motion.div
          className="absolute right-0 top-full mt-2 w-72 glass-modal p-4 z-[1000] text-xs space-y-2.5 shadow-2xl"
          style={{ background: 'var(--bg-panel)', transformOrigin: 'top right' }}
          {...iosMenu}
        >
          <div className="font-bold text-[var(--text-primary)] text-sm">{t('sync.panelTitle')}</div>
          <div className="flex justify-between text-[var(--text-secondary)]">
            <span>{t('sync.status')}</span>
            <span className="font-semibold text-[var(--text-primary)]">{connection === 'online' ? t('sync.connected') : connection === 'offline' ? t('sync.unreachable') : t('sync.connecting')}</span>
          </div>
          <div className="flex justify-between text-[var(--text-secondary)]">
            <span>{t('sync.lastChecked')}</span>
            <span className="font-mono text-[var(--text-primary)]">{ago(lastSyncAt)}</span>
          </div>
          <div className="flex justify-between text-[var(--text-secondary)]">
            <span>{t('sync.waitingUploads')}</span>
            <span className="font-mono text-[var(--text-primary)]">{pendingUploads}</span>
          </div>
          <p className="text-[11px] text-[var(--text-tertiary)] leading-relaxed">
            {t('sync.help')}
          </p>
          <button onClick={retry} disabled={busy} className="btn-secondary w-full text-xs py-1.5">
            <RefreshCw size={13} className={busy ? 'animate-spin' : ''} />
            <span>{t('sync.syncNow')}</span>
          </button>
        </motion.div>
      )}
      </AnimatePresence>
    </div>
  );
}
