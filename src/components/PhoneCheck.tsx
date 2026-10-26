import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, CheckCircle2, ChevronDown, Lock, LogOut, OctagonX, LayoutGrid, RefreshCw } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useSync } from '../contexts/SyncContext';
import {
  FREQUENCY_LABEL,
  checkAction,
  fetchMachines,
  endTaskWaiting,
  isDue,
  isLockedFor,
  machineSubtitle,
  machineSummary,
  reportIssue,
  setStops,
  timeAgo,
  toFleet,
  type MachineCheck,
  type MachineOwner,
} from '../lib/fleet';
import { EASE_OUT, SPRING_POP } from '../lib/motion';
import { calesOf, type CaleRow } from '../lib/cales';
import { currentRegion } from '../lib/instance';
import { shiftOf } from '../lib/shifts';
import CalesBox from './CalesBox';
import { useT } from '../i18n';
import { fmtDuration } from '../i18n/format';

/*
 * The screen a machine's QR code opens on a phone: that machine only, big and simple.
 * What is still to do comes first, each with one big "Done" button; problems are on top in red;
 * finished checks fold away. Nothing else from the app is on this screen. Same rules as the app:
 * everyone does every due check themselves, and the cales box once per shift.
 */

export default function PhoneCheck({ machineId, onOpenApp }: { machineId: string; onOpenApp: () => void }) {
  const { t } = useT('preventive');
  const { user, logout } = useAuth();
  const { versions, machines, machinesLoaded, features } = useSync();
  const [checks, setChecks] = useState<MachineCheck[] | null>(null);
  const [owners, setOwnerRows] = useState<MachineOwner[]>([]);
  /** Checks I did this period; this machine's cales box (state, my check this shift, open requests). */
  const [mine, setMine] = useState<{ myDone: string[]; cales: CaleRow[]; checked: boolean; requested: number[]; skew: number }>({
    myDone: [],
    cales: [],
    checked: false,
    requested: [],
    skew: 0,
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [problemFor, setProblemFor] = useState<string | null>(null); // a check id, or '__machine'
  const [problemText, setProblemText] = useState('');
  const [problemStops, setProblemStops] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      const res = await fetchMachines();
      setChecks(res.checks.filter((c) => c.machine_id === machineId));
      setOwnerRows(res.owners || []);
      setMine({
        myDone: res.myDone,
        cales: res.cales,
        checked: res.calesChecked.includes(machineId),
        requested: res.calesRequests.filter((r) => r.machine_id === machineId).map((r) => r.height),
        skew: res.serverTime - Date.now(),
      });
      setError('');
    } catch (err: any) {
      setError(err?.message || t('errors.loadMachines'));
    }
  }, [machineId, t]);

  // Reload when anyone changes something (another phone, a PC), and when a new shift starts.
  const shiftKey = shiftOf(now + mine.skew, currentRegion().timeZone).key;
  useEffect(() => {
    load();
  }, [load, versions.machines, shiftKey]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(id);
  }, [toast]);

  const machine = useMemo(() => toFleet(machines).find((m) => m.id === machineId) ?? null, [machines, machineId]);
  const locked = isLockedFor(machineId, user, owners);
  const summary = useMemo(() => machineSummary(checks || [], now), [checks, now]);
  const list = (checks || []).filter((c) => c.kind === 'CHECK' && !endTaskWaiting(c, now)); // end tasks show in their last 45 minutes
  // Everyone does every check in its period themselves; admins see whether anyone did it.
  const dueForMe = (c: MachineCheck) => (features.shiftChecks && !locked && user?.role !== 'ADMIN' ? !mine.myDone.includes(c.id) : isDue(c, now));
  const toDo = list.filter((c) => c.status !== 'PROBLEM' && dueForMe(c));
  const doneList = list.filter((c) => c.status !== 'PROBLEM' && !dueForMe(c));
  const calesState = useMemo(() => calesOf(mine.cales, machineId), [mine.cales, machineId]);
  const problems = summary.problems;
  const doneCount = list.length - toDo.length - list.filter((c) => c.status === 'PROBLEM').length;

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError('');
    try {
      await fn();
      await load();
      return true;
    } catch (err: any) {
      setError(err?.message || t('common:errors.generic'));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const markDone = async (c: MachineCheck) => {
    if (await run(`done:${c.id}`, () => checkAction(machineId, c.id, 'DONE'))) {
      navigator.vibrate?.(18);
      setToast({ id: Date.now(), text: t('phone.marked', { title: c.title }) });
    }
  };

  const openProblem = (id: string) => {
    setProblemFor(id);
    setProblemText('');
    setProblemStops(false);
  };

  const sendProblem = async () => {
    const text = problemText.trim();
    if (text.length < 3) return setError(t('errors.describeProblem'));
    const ok = await run(`problem:${problemFor}`, () =>
      problemFor === '__machine' ? reportIssue(machineId, text, problemStops) : checkAction(machineId, problemFor!, 'PROBLEM', text, problemStops),
    );
    if (ok) {
      navigator.vibrate?.([20, 60, 20]);
      setProblemFor(null);
    }
  };

  // ---- Screens without a checklist ----
  const shell = (body: React.ReactNode) => (
    <main className="phone-check">
      <div className="phone-wrap py-10 space-y-5 text-center">
        {body}
        <button className="btn-secondary w-full phone-big" onClick={onOpenApp}>
          <LayoutGrid size={18} />
          <span>{t('phone.openApp')}</span>
        </button>
      </div>
    </main>
  );
  if (!features.preventive) return shell(<p className="text-base text-[var(--text-secondary)]">{t('phone.notUsed')}</p>);
  if (machinesLoaded && !machine) {
    return shell(
      <>
        <AlertTriangle size={36} className="mx-auto text-[var(--orange-500)]" />
        <p className="text-base text-[var(--text-secondary)]">{t('phone.unknown')}</p>
        <p className="font-mono text-sm text-[var(--text-tertiary)]">{machineId}</p>
      </>,
    );
  }

  const status = summary.down
    ? { cls: 'is-down', icon: <OctagonX size={16} />, text: t('stop.badge') }
    : problems.length
      ? { cls: 'is-problem', icon: <AlertTriangle size={16} />, text: t('status.problems', { count: problems.length }) }
      : toDo.length
        ? { cls: 'is-due', icon: <RefreshCw size={15} />, text: t('status.checksToDo', { count: toDo.length }) }
        : { cls: 'is-ok', icon: <CheckCircle2 size={16} />, text: t('phone.working') };

  const problemForm = (forId: string) => (
    <AnimatePresence initial={false}>
      {problemFor === forId && (
        <motion.div
          key="form"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.22, ease: EASE_OUT }}
          className="overflow-hidden"
        >
          <div className="pt-3 space-y-3">
            <textarea
              autoFocus
              rows={3}
              className="aurora-input w-full phone-input"
              placeholder={t('problem.placeholder')}
              value={problemText}
              maxLength={300}
              onChange={(e) => setProblemText(e.target.value)}
            />
            <label className={`phone-stop-toggle ${problemStops ? 'on' : ''}`}>
              <input type="checkbox" checked={problemStops} onChange={(e) => setProblemStops(e.target.checked)} />
              <OctagonX size={18} />
              <span>{t('problem.stops')}</span>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button className="btn-secondary phone-big" onClick={() => setProblemFor(null)}>
                {t('common:actions.cancel')}
              </button>
              <button className="btn-danger phone-big" disabled={!!busy} onClick={sendProblem}>
                {busy?.startsWith('problem:') ? '...' : t('problem.send')}
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <div className="phone-check">
      {/* Machine and how it is doing */}
      <header className={`phone-head ${status.cls}`} style={{ '--accent': machine?.accent } as React.CSSProperties}>
        <div className="phone-wrap flex items-center gap-3 py-3">
          {machine && <img src={machine.image} alt="" className="phone-head-img" />}
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-bold leading-tight text-[var(--text-primary)] truncate">{machine?.name ?? machineId}</h1>
            <div className="text-sm text-[var(--text-tertiary)] truncate">{machine ? machineSubtitle(machine) : ''}</div>
          </div>
          <span className="phone-status">
            {status.icon}
            <span>{status.text}</span>
          </span>
        </div>
      </header>

      <main className="phone-wrap py-4 space-y-5">
        {error && <div className="badge-danger w-full justify-center py-2.5 text-sm">{error}</div>}

        {locked && (
          <div className="phone-note">
            <Lock size={18} className="shrink-0 text-[var(--orange-500)]" />
            <span>{t('phone.viewOnly')}</span>
          </div>
        )}

        {/* Progress */}
        {checks && list.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-semibold text-[var(--text-secondary)]">{t('phone.checks')}</span>
              <span className="text-sm text-[var(--text-secondary)]">{t('phone.progress', { done: doneCount, total: list.length })}</span>
            </div>
            <div className="phone-progress">
              <motion.span initial={false} animate={{ width: `${list.length ? (doneCount / list.length) * 100 : 0}%` }} transition={SPRING_POP} />
            </div>
          </div>
        )}

        {/* The cales box, checked once per shift */}
        {features.shiftChecks && checks && machine && (
          <section className="phone-row flex justify-center">
            <CalesBox machine={machine} canAct={!locked} state={calesState} checked={mine.checked} requested={mine.requested} onChanged={load} />
          </section>
        )}

        {/* Open problems */}
        {problems.length > 0 && (
          <section className="space-y-2.5">
            <h2 className="phone-section text-[var(--rose-500)]">{t('phone.problems')}</h2>
            {problems.map((p) => (
              <div key={p.id} className={`phone-problem ${p.stops ? 'stops' : ''}`}>
                <div className="flex items-start gap-2.5">
                  {p.stops ? <OctagonX size={20} className="shrink-0 mt-0.5" /> : <AlertTriangle size={20} className="shrink-0 mt-0.5" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-base font-semibold text-[var(--text-primary)] break-words">{p.kind === 'ISSUE' ? p.note : p.title}</div>
                    {p.kind === 'CHECK' && p.note && <div className="text-sm text-[var(--rose-500)] break-words">{p.note}</div>}
                    <div className="text-xs text-[var(--text-tertiary)] mt-1">{t('problem.reportedBy', { user: p.status_by, time: timeAgo(p.status_at, now) })}</div>
                    {!!p.stops && <div className="phone-stop-badge">{t('stop.since', { time: fmtDuration((now - (p.status_at ?? now)) / 1000) })}</div>}
                  </div>
                </div>
                {!locked && (
                  <div className="grid grid-cols-2 gap-2 mt-3">
                    <button
                      className="btn-secondary phone-mid"
                      disabled={!!busy}
                      onClick={() => run(`stops:${p.id}`, () => setStops(machineId, p.id, !p.stops))}
                    >
                      {p.stops ? t('stop.markRunning') : t('stop.markStopped')}
                    </button>
                    <button className="btn-success phone-mid" disabled={!!busy} onClick={() => run(`fix:${p.id}`, () => checkAction(machineId, p.id, 'RESOLVE'))}>
                      <CheckCircle2 size={17} />
                      <span>{t('problem.fixed')}</span>
                    </button>
                  </div>
                )}
              </div>
            ))}
          </section>
        )}

        {/* Still to do */}
        {!checks ? (
          <div className="py-10 text-center text-[var(--text-tertiary)]">
            <RefreshCw size={20} className="animate-spin mx-auto" />
          </div>
        ) : list.length === 0 ? (
          <p className="text-center text-base text-[var(--text-secondary)] py-6">{t('phone.noChecks')}</p>
        ) : toDo.length === 0 ? (
          <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={SPRING_POP} className="phone-all-done">
            <CheckCircle2 size={34} />
            <span>{t('phone.allDone')}</span>
          </motion.div>
        ) : (
          <section className="space-y-2.5">
            <h2 className="phone-section text-[var(--orange-500)]">{t('phone.toDo')}</h2>
            <AnimatePresence initial={false}>
              {toDo.map((c) => (
                <motion.div
                  key={c.id}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: 40, transition: { duration: 0.2 } }}
                  transition={SPRING_POP}
                  className="phone-row"
                >
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-[17px] font-semibold leading-snug text-[var(--text-primary)] break-words">{c.title}</div>
                      <div className="text-xs text-[var(--text-tertiary)] mt-0.5">
                        {c.frequency ? FREQUENCY_LABEL[c.frequency] : ''}
                        {c.last_done_at ? ` · ${t('check.doneBy', { time: timeAgo(c.last_done_at, now), user: c.last_done_by })}` : ''}
                      </div>
                    </div>
                    {!locked && (
                      <button className="btn-success phone-done" disabled={!!busy} onClick={() => markDone(c)} aria-label={`${t('phone.done')}: ${c.title}`}>
                        <CheckCircle2 size={20} />
                        <span>{busy === `done:${c.id}` ? '...' : t('phone.done')}</span>
                      </button>
                    )}
                  </div>
                  {!locked && problemFor !== c.id && (
                    <button className="phone-link no-glass" onClick={() => openProblem(c.id)}>
                      <AlertTriangle size={14} />
                      {t('phone.problem')}
                    </button>
                  )}
                  {problemForm(c.id)}
                </motion.div>
              ))}
            </AnimatePresence>
          </section>
        )}

        {/* Done (folded) */}
        {doneList.length > 0 && (
          <section className="space-y-2">
            <button className="phone-fold" onClick={() => setShowDone((v) => !v)} aria-expanded={showDone}>
              <span>{showDone ? t('phone.hideDone') : t('phone.showDone', { count: doneList.length })}</span>
              <ChevronDown size={18} className={`transition-transform ${showDone ? 'rotate-180' : ''}`} />
            </button>
            <AnimatePresence initial={false}>
              {showDone && (
                <motion.div
                  key="done"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.22, ease: EASE_OUT }}
                  className="overflow-hidden space-y-2"
                >
                  {doneList.map((c) => (
                    <div key={c.id} className="phone-row is-done">
                      <div className="flex items-center gap-3">
                        <CheckCircle2 size={20} className="shrink-0 text-[var(--green-500)]" />
                        <div className="min-w-0 flex-1">
                          <div className="text-base text-[var(--text-primary)] break-words">{c.title}</div>
                          <div className="text-xs text-[var(--text-tertiary)]">
                            {c.last_done_at ? t('check.doneBy', { time: timeAgo(c.last_done_at, now), user: c.last_done_by }) : ''}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </section>
        )}

        {/* A problem with the machine itself */}
        {!locked && checks && (
          <section className="phone-row">
            {problemFor !== '__machine' ? (
              <button className="btn-warning w-full phone-big" onClick={() => openProblem('__machine')}>
                <AlertTriangle size={18} />
                <span>{t('phone.reportMachine')}</span>
              </button>
            ) : (
              <div className="text-base font-semibold text-[var(--text-primary)]">{t('phone.reportMachine')}</div>
            )}
            {problemForm('__machine')}
          </section>
        )}

        <footer className="pt-2 pb-6 space-y-3 text-center">
          <div className="text-xs text-[var(--text-tertiary)]">{t('phone.signedInAs', { user: user?.username })}</div>
          <div className="grid grid-cols-2 gap-2">
            <button className="btn-secondary phone-mid" onClick={onOpenApp}>
              <LayoutGrid size={16} />
              <span>{t('phone.openApp')}</span>
            </button>
            <button className="btn-secondary phone-mid" onClick={() => logout()}>
              <LogOut size={16} />
              <span>{t('common:actions.signOut')}</span>
            </button>
          </div>
        </footer>
      </main>

      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12 }}
            transition={SPRING_POP}
            className="phone-toast"
            role="status"
          >
            <CheckCircle2 size={18} />
            <span>{toast.text}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
