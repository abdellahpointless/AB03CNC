import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Sparkles, X } from 'lucide-react';
import { useT } from '../i18n';
import { fmtDate } from '../i18n/format';
import { useSync } from '../contexts/SyncContext';
import { currentRegion, scopedKey } from '../lib/instance';
import { iosBackdrop, iosSurface } from '../lib/motion';
import { releasesFor } from '../lib/whatsNew';

const SEEN = scopedKey('cnc-whatsnew-seen');

/** "What's new" in the header: a dot while the newest update is unread, the list in a sheet. */
export function WhatsNewButton() {
  const { t, i18n } = useT('app');
  const releases = releasesFor(currentRegion().id, useSync().features);
  const newest = releases[0]?.id ?? '';
  const [seen, setSeen] = useState(() => {
    try {
      return localStorage.getItem(SEEN) ?? '';
    } catch {
      return newest;
    }
  });
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const show = () => {
    setOpen(true);
    setSeen(newest);
    try {
      localStorage.setItem(SEEN, newest);
    } catch {
      /* the dot comes back next time */
    }
  };
  const close = () => {
    setOpen(false);
    opener.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (!releases.length) return null;
  const lang = i18n.language === 'tr' ? 'tr' : 'en';
  const unread = seen !== newest;
  return (
    <>
      <button ref={opener} type="button" onClick={show} className="btn-secondary text-xs py-1.5 px-2.5 relative" title={t('whatsNew.title')} aria-label={unread ? t('whatsNew.unread') : t('whatsNew.title')}>
        <Sparkles size={14} />
        <span className="hidden md:inline">{t('whatsNew.title')}</span>
        {unread && <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-[var(--accent-primary)] border-2 border-[var(--bg-panel)]" aria-hidden="true" />}
      </button>
      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div className="fixed inset-0 modal-backdrop flex items-center justify-center p-4 z-[99999]" onMouseDown={(e) => e.target === e.currentTarget && close()} {...iosBackdrop}>
              <motion.div className="glass-modal max-w-lg w-full p-6 max-h-[85vh] overflow-y-auto" {...iosSurface} role="dialog" aria-modal="true" aria-labelledby="whats-new-title">
                <div className="flex items-center justify-between mb-4">
                  <h3 id="whats-new-title" className="font-bold text-[var(--text-primary)] flex items-center gap-2">
                    <Sparkles size={16} className="text-[var(--accent-primary)]" /> {t('whatsNew.title')}
                  </h3>
                  <button ref={closeBtn} onClick={close} className="btn-icon w-8 h-8" title={t('common:actions.close')} aria-label={t('common:actions.close')}>
                    <X size={14} />
                  </button>
                </div>
                <ol className="space-y-5">
                  {releases.map((r) => (
                    <li key={r.id}>
                      <div className="flex items-baseline justify-between gap-3">
                        <h4 className="text-sm font-semibold text-[var(--text-primary)]">{r[lang].title}</h4>
                        <span className="text-xs text-[var(--text-tertiary)] font-mono shrink-0">{fmtDate(r.date)}</span>
                      </div>
                      <ul className="mt-1.5 space-y-1 list-disc pl-5 text-sm text-[var(--text-secondary)]">
                        {r[lang].items.map((it) => (
                          <li key={it}>{it}</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ol>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
