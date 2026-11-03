import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, useReducedMotion } from 'motion/react';
import { Lock, X } from 'lucide-react';
import { useT } from '../i18n';
import { iosBackdrop, iosSurface } from '../lib/motion';

/** Shown instead of the toolpath viewer where it is switched off for the country: its video (in the page's language) and "coming soon". */
export default function ToolpathSoon({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useT('remapper');
  const lang = i18n.language === 'tr' ? 'tr' : 'en';
  const still = useReducedMotion();
  const closeBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <motion.div className="fixed inset-0 modal-backdrop flex items-center justify-center p-4 z-[99999]" onMouseDown={(e) => e.target === e.currentTarget && onClose()} {...iosBackdrop}>
      <motion.div className="glass-modal !bg-[var(--bg-card)] max-w-3xl w-full overflow-hidden" {...iosSurface} role="dialog" aria-modal="true" aria-labelledby="toolpath-soon-title" aria-describedby="toolpath-soon-text">
        <div className="relative bg-[#0E1421]">
          {/* Silent, with its controls (pause, replay); the same words are under it for screen readers. */}
          <video poster={`/toolpath-soon-${lang}.jpg`} autoPlay={!still} muted playsInline controls aria-describedby="toolpath-soon-text" className="block w-full aspect-video">
            <source src={`/toolpath-soon-${lang}.webm`} type="video/webm" />
            <source src={`/toolpath-soon-${lang}.mp4`} type="video/mp4" />
          </video>
          <span className="absolute top-3 left-3 inline-flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-xs font-semibold text-white backdrop-blur">
            <Lock size={12} /> {t('toolpath.soon.badge')}
          </span>
        </div>
        <div className="p-6">
          <div className="flex items-start justify-between gap-3">
            <h3 id="toolpath-soon-title" className="text-lg font-bold text-[var(--text-primary)]">
              {t('toolpath.soon.title')}
            </h3>
            <button ref={closeBtn} onClick={onClose} className="btn-icon w-8 h-8 shrink-0" title={t('common:actions.close')} aria-label={t('common:actions.close')}>
              <X size={14} />
            </button>
          </div>
          <p id="toolpath-soon-text" className="mt-2 text-sm text-[var(--text-secondary)]">
            {t('toolpath.soon.text')}
          </p>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}
