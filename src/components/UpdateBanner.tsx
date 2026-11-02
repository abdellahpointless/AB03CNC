import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { RefreshCw } from 'lucide-react';
import { useT } from '../i18n';

/** How often an open page asks whether a newer version was deployed (and each time it is shown again). */
const EVERY_MS = 5 * 60 * 1000;

/**
 * A small message when a newer version of the app is live: the build writes /version.json (see
 * vite.config.ts) and this page compares it with the version it runs.
 */
export function UpdateBanner() {
  const { t } = useT('app');
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (__APP_VERSION__ === 'dev') return;
    let stop = false;
    const check = async () => {
      try {
        const res = await fetch('/version.json', { cache: 'no-store' });
        const { version } = (await res.json()) as { version?: string };
        if (!stop && version && version !== __APP_VERSION__) setReady(true);
      } catch {
        /* offline: ask again later */
      }
    };
    const onShow = () => document.visibilityState === 'visible' && check();
    const timer = setInterval(check, EVERY_MS);
    document.addEventListener('visibilitychange', onShow);
    check();
    return () => {
      stop = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onShow);
    };
  }, []);
  return (
    <AnimatePresence>
      {ready && (
        <motion.div
          role="status"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 16 }}
          className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[100000] glass-modal !bg-[var(--bg-card)] rounded-full shadow-2xl pl-4 pr-1.5 py-1.5 flex items-center gap-3 text-sm text-[var(--text-primary)] max-w-[calc(100vw-2rem)]"
        >
          <span>{t('update.ready')}</span>
          <button type="button" onClick={() => location.reload()} className="btn-primary text-xs py-1.5 px-3 rounded-full">
            <RefreshCw size={13} /> {t('update.refresh')}
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
