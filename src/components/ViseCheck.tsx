import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { CheckCircle2, Lock, X } from 'lucide-react';
import { checkAction, reportVise, timeAgo, type FleetMachine, type MachineCheck } from '../lib/fleet';
import { viseId } from '../lib/cales';
import { iosBackdrop, iosSurface } from '../lib/motion';
import { useT } from '../i18n';

/*
 * The machine's vise (mengene): always good, until someone reports it damaged. Reporting opens a
 * problem on the machine (the admins get it on Telegram); "repaired" closes it. Nothing to confirm
 * each shift.
 */

const PIC = { good: '/vise/vise-good.svg', damaged: '/vise/vise-damaged.svg' };

export default function ViseCheck({
  machine,
  checks,
  canAct,
  onChanged,
  onOpenChange,
}: {
  machine: FleetMachine;
  /** The machine's checks and problems (the vise report is one of them, see viseId). */
  checks: MachineCheck[];
  canAct: boolean;
  onChanged: () => Promise<unknown> | void;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useT('preventive');
  const [open, setOpen] = useState(false);
  const report = checks.find((c) => c.id === viseId(machine.id));
  const damaged = !!report;
  useEffect(() => onOpenChange?.(open), [open, onOpenChange]);

  return (
    <>
      <button
        type="button"
        className={`vise-thumb no-glass ${damaged ? 'is-damaged' : ''}`}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('vise.openLabel', { name: machine.name, status: damaged ? t('vise.damaged') : t('vise.good') })}
      >
        <img src={damaged ? PIC.damaged : PIC.good} alt="" draggable={false} />
        <span className="vise-thumb-title">{t('vise.title')}</span>
        <span className="vise-thumb-status">
          <i className="cales-dot" />
          {damaged ? t('vise.damaged') : t('vise.good')}
        </span>
      </button>
      {createPortal(
        <AnimatePresence>
          {open && <ViseDialog key="vise" machine={machine} report={report} canAct={canAct} onChanged={onChanged} onClose={() => setOpen(false)} />}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}

function ViseDialog({
  machine,
  report,
  canAct,
  onChanged,
  onClose,
}: {
  machine: FleetMachine;
  report?: MachineCheck;
  canAct: boolean;
  onChanged: () => Promise<unknown> | void;
  onClose: () => void;
}) {
  const { t } = useT('preventive');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const closeRef = useRef<HTMLButtonElement>(null);
  const damaged = !!report;

  // Focus only when the window opens: refocusing on a re-render would scroll it under the finger.
  useEffect(() => closeRef.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await onChanged();
      onClose();
    } catch (err: any) {
      setError(err?.message || t('common:errors.generic'));
    } finally {
      setBusy(false);
    }
  };

  const picture = (kind: 'good' | 'damaged') => (
    <figure className={`vise-pic ${kind} ${(kind === 'damaged') === damaged ? 'is-now' : ''}`}>
      <img src={PIC[kind]} alt={t(`vise.${kind}Alt`)} draggable={false} />
      <figcaption>
        <strong>{t(`vise.${kind}`)}</strong>
        <span>{t(`vise.${kind}Help`)}</span>
      </figcaption>
    </figure>
  );

  return (
    <motion.div {...iosBackdrop} className="fixed inset-0 modal-backdrop z-[99995] flex items-center justify-center p-3 sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <motion.div {...iosSurface} role="dialog" aria-modal="true" aria-labelledby="vise-title" className="glass-modal vise-dialog w-full max-w-2xl max-h-[90vh] overflow-y-auto p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="vise-title" className="text-lg font-bold text-[var(--text-primary)]">
              {t('vise.dialogTitle', { name: machine.name })}
            </h2>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">{t('vise.help')}</p>
          </div>
          <button ref={closeRef} type="button" className="btn-icon" onClick={onClose} aria-label={t('common:actions.close')}>
            <X size={15} />
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {picture('good')}
          {picture('damaged')}
        </div>

        {damaged && (
          <div className="p-3 rounded-[var(--radius-md)] bg-[var(--rose-500)]/10 border border-[var(--rose-500)]/30 text-xs space-y-0.5">
            <div className="font-semibold text-[var(--text-primary)]">{report!.note}</div>
            <div className="text-[var(--text-secondary)]">{t('vise.reportedBy', { name: report!.status_by, time: timeAgo(report!.status_at, Date.now()) })}</div>
          </div>
        )}

        {error && (
          <div role="alert" className="badge-danger w-full justify-center py-2 text-xs">
            {error}
          </div>
        )}

        {!canAct ? (
          <div className="badge-warning w-full justify-center py-2 text-xs">
            <Lock size={13} /> {t('sheet.viewOnly')}
          </div>
        ) : damaged ? (
          <button type="button" className="btn-success w-full text-sm py-2.5" disabled={busy} onClick={() => run(() => checkAction(machine.id, report!.id, 'RESOLVE'))}>
            <CheckCircle2 size={15} />
            <span>{t('vise.repaired')}</span>
          </button>
        ) : (
          <div className="space-y-2">
            <label className="block text-xs font-semibold text-[var(--text-secondary)]" htmlFor="vise-note">
              {t('vise.noteLabel')}
            </label>
            <input id="vise-note" className="aurora-input w-full text-sm" maxLength={300} placeholder={t('vise.notePlaceholder')} value={note} onChange={(e) => setNote(e.target.value)} />
            <button type="button" className="btn-danger w-full text-sm py-2.5" disabled={busy} onClick={() => run(() => reportVise(machine.id, note.trim() || undefined))}>
              <span>{t('vise.report')}</span>
            </button>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
