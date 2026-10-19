import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Lock,
  History as HistoryIcon,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Users,
  Wrench,
  X,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useSync } from '../contexts/SyncContext';
import {
  FLEET,
  FREQUENCY_LABEL,
  type FleetMachine,
  type Frequency,
  type MachineCheck,
  type MachineEvent,
  type MachineOwner,
  checkAction,
  createCheck,
  deleteCheck,
  fetchMachines,
  fetchUsers,
  isLockedFor,
  isDue,
  machineSummary,
  reportIssue,
  setOwners,
  timeAgo,
  updateCheck,
} from '../lib/fleet';
import { EASE_OUT, SPRING_POP, iosBackdrop, iosSurface, waveItem } from '../lib/motion';

type Summary = ReturnType<typeof machineSummary>;

const ACTION_TEXT: Record<MachineEvent['action'], string> = {
  DONE: 'marked done',
  PROBLEM: 'reported a problem',
  RESOLVE: 'marked fixed',
  CHECK_ADDED: 'added check',
  CHECK_EDITED: 'edited check',
  CHECK_REMOVED: 'removed check',
  OWNERS_SET: 'set the responsible people',
};

export default function PreventiveActions() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const { versions } = useSync();
  const [checks, setChecks] = useState<MachineCheck[] | null>(null);
  const [events, setEvents] = useState<MachineEvent[]>([]);
  const [owners, setOwnerRows] = useState<MachineOwner[]>([]);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<{ id: string; above: boolean } | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      const res = await fetchMachines();
      setChecks(res.checks);
      setEvents(res.events);
      setOwnerRows(res.owners || []);
      setLoadError('');
    } catch (err: any) {
      setLoadError(err?.message || 'Could not load the machines');
    }
  }, []);

  // Reload whenever any PC changes something (versions.machines is bumped by the server).
  useEffect(() => {
    load();
  }, [load, versions.machines]);

  // "Due" depends on the clock (a daily check becomes due again at midnight).
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const byMachine = useMemo(() => {
    const map = new Map<string, MachineCheck[]>();
    for (const m of FLEET) map.set(m.id, []);
    for (const c of checks || []) map.get(c.machine_id)?.push(c);
    return map;
  }, [checks]);

  const summaries = useMemo(() => {
    const out = new Map<string, Summary>();
    for (const m of FLEET) out.set(m.id, machineSummary(byMachine.get(m.id) || [], now));
    return out;
  }, [byMachine, now]);

  const counts = useMemo(() => {
    let problem = 0, due = 0, ok = 0;
    for (const s of summaries.values()) s.state === 'problem' ? problem++ : s.state === 'due' ? due++ : ok++;
    return { problem, due, ok };
  }, [summaries]);

  const ownersOf = useCallback((id: string) => owners.filter((o) => o.machine_id === id), [owners]);
  const myMachines = useMemo(() => (user ? owners.filter((o) => o.user_id === user.id).map((o) => o.machine_id) : []), [owners, user]);
  const lastEvent = useCallback((id: string) => events.find((e) => e.machine_id === id), [events]);
  const selectedMachine = FLEET.find((m) => m.id === selected) || null;

  return (
    <div className="flex flex-col space-y-5 max-w-7xl mx-auto w-full pb-20">
      {/* Header */}
      <div className="aurora-card aurora-card-static p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-[var(--radius-md)] bg-[var(--blue-500)]/15 border border-[var(--blue-500)]/30 flex items-center justify-center text-[var(--blue-500)] shrink-0">
            <Activity size={20} />
          </div>
          <div>
            <h2 className="text-lg font-bold text-[var(--text-primary)]">Preventive actions</h2>
            <p className="text-xs text-[var(--text-secondary)]">
              Point at a machine to see how it is doing. Click it to open its checklist.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {myMachines.length > 0 && !isAdmin && (
            <span className="badge-neutral" title="You can only update the machines you look after">
              <Wrench size={13} /> You look after {myMachines.join(', ')}
            </span>
          )}
          <span className={counts.problem ? 'badge-danger' : 'badge-neutral'}>
            <AlertTriangle size={13} /> {counts.problem} with a problem
          </span>
          <span className={counts.due ? 'badge-warning' : 'badge-neutral'}>
            <Clock size={13} /> {counts.due} checks to do
          </span>
          <span className="badge-positive">
            <CheckCircle2 size={13} /> {counts.ok} all good
          </span>
          <button onClick={load} className="btn-icon" title="Refresh" aria-label="Refresh">
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {loadError && <div className="badge-danger w-full justify-center py-2 text-xs">{loadError}</div>}

      {/* Machine floor */}
      <div className="machine-floor grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-5 gap-y-8 pt-2">
        {FLEET.map((m, i) => (
          <MachineCard
            key={m.id}
            index={i}
            machine={m}
            summary={summaries.get(m.id)!}
            loading={!checks}
            last={lastEvent(m.id)}
            now={now}
            owners={ownersOf(m.id)}
            mine={myMachines.includes(m.id)}
            locked={isLockedFor(m.id, user, owners)}
            hovered={hover?.id === m.id ? hover : null}
            onHover={setHover}
            onOpen={() => {
              setHover(null);
              setSelected(m.id);
            }}
          />
        ))}
      </div>

      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {selectedMachine && (
              <MachineSheet
                key={selectedMachine.id}
                machine={selectedMachine}
                checks={byMachine.get(selectedMachine.id) || []}
                events={events.filter((e) => e.machine_id === selectedMachine.id).slice(0, 15)}
                summary={summaries.get(selectedMachine.id)!}
                isAdmin={isAdmin}
                owners={ownersOf(selectedMachine.id)}
                locked={isLockedFor(selectedMachine.id, user, owners)}
                now={now}
                onChanged={load}
                onClose={() => setSelected(null)}
              />
            )}
          </AnimatePresence>,
          document.body,
        )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Machine card on the floor
// ---------------------------------------------------------------------------------------------

function MachineCard({
  index,
  machine,
  summary,
  loading,
  last,
  now,
  owners,
  mine,
  locked,
  hovered,
  onHover,
  onOpen,
}: {
  index: number;
  machine: FleetMachine;
  summary: Summary;
  loading: boolean;
  last?: MachineEvent;
  now: number;
  owners: MachineOwner[];
  mine: boolean;
  locked: boolean;
  hovered: { id: string; above: boolean } | null;
  onHover: (h: { id: string; above: boolean } | null) => void;
  onOpen: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const state = loading ? 'loading' : summary.state;


  const enter = () => {
    const r = ref.current?.getBoundingClientRect();
    const above = r ? window.innerHeight - r.bottom < 300 && r.top > 300 : false;
    onHover({ id: machine.id, above });
  };

  const label =
    state === 'problem'
      ? `${summary.problems.length} problem${summary.problems.length > 1 ? 's' : ''}`
      : state === 'due'
        ? `${summary.due.length} check${summary.due.length > 1 ? 's' : ''} to do`
        : state === 'ok'
          ? 'All good'
          : '...';

  return (
    <motion.div
      {...waveItem(index)}
      className="relative machine-slot"
      onMouseEnter={enter}
      onMouseLeave={() => onHover(null)}
    >
      <motion.div
        ref={ref}
        role="button"
        tabIndex={0}
        aria-label={`${machine.id}, ${machine.brand} ${machine.model}: ${label}. Open checklist`}
        data-state={state}
        data-locked={locked ? 'true' : undefined}
        className="machine-card"
        style={{ '--accent': machine.accent } as React.CSSProperties}
        whileHover={{ y: -10, scale: 1.035 }}
        whileTap={{ scale: 0.985 }}
        transition={SPRING_POP}
        onFocus={enter}
        onBlur={() => onHover(null)}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen();
          }
        }}
      >
        <div className="machine-stage">
          <div className="machine-floor-shadow" />
          <img src={machine.image} alt="" className="machine-img" draggable={false} loading="lazy" />
          {locked && (
            <span className="machine-lock" title="Locked for you" aria-hidden>
              <Lock size={12} />
            </span>
          )}
          {state === 'problem' && (
            <span className="machine-alert" aria-hidden>
              <AlertTriangle size={14} />
            </span>
          )}
        </div>
        <div className="flex items-end justify-between gap-2 px-4 pb-4 pt-1 machine-label">
          <div className="min-w-0">
            <div className="text-[15px] font-bold text-[var(--text-primary)] leading-tight">{machine.id}</div>
            <div className="text-[11px] text-[var(--text-tertiary)] truncate">
              {machine.brand} {machine.model}
            </div>
          </div>
          <span
            className={`shrink-0 text-[11px] py-0.5 px-2 ${
              state === 'problem' ? 'badge-danger' : state === 'due' ? 'badge-warning' : state === 'ok' ? 'badge-positive' : 'badge-neutral'
            }`}
          >
            {label}
          </span>
        </div>
        {(owners.length > 0 || locked) && (
          <div className="machine-owners">
            {locked ? <Lock size={11} className="shrink-0" /> : <Users size={11} className="shrink-0" />}
            <span className="truncate">
              {mine ? 'You' + (owners.length > 1 ? ` + ${owners.length - 1}` : '') : owners.map((o) => o.username).join(', ') || 'Nobody assigned'}
            </span>
          </div>
        )}
      </motion.div>

      {/* "What's going on" pop-up */}
      <AnimatePresence>
        {hovered && !loading && (
          <motion.div
            key="pop"
            initial={{ opacity: 0, scale: 0.85, y: hovered.above ? 8 : -8, filter: 'blur(6px)' }}
            animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)', transitionEnd: { filter: 'none' } }}
            exit={{ opacity: 0, scale: 0.92, filter: 'blur(4px)', transition: { duration: 0.14, ease: EASE_OUT } }}
            transition={SPRING_POP}
            style={{ transformOrigin: hovered.above ? 'bottom center' : 'top center' }}
            className={`machine-pop glass-modal ${hovered.above ? 'bottom-full mb-3' : 'top-full mt-3'}`}
          >
            <MachinePopContent machine={machine} summary={summary} last={last} now={now} owners={owners} locked={locked} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function MachinePopContent({
  machine,
  summary,
  last,
  now,
  owners,
  locked,
}: {
  machine: FleetMachine;
  summary: Summary;
  last?: MachineEvent;
  now: number;
  owners: MachineOwner[];
  locked: boolean;
}) {
  return (
    <div className="p-4 space-y-3 text-xs relative z-10">
      <div className="flex items-center justify-between">
        <span className="font-bold text-sm text-[var(--text-primary)]">
          {machine.id} <span className="text-[var(--text-tertiary)] font-normal">· {machine.model}</span>
        </span>
        {summary.state === 'ok' && <CheckCircle2 size={16} className="text-[var(--green-500)]" />}
      </div>

      {summary.problems.length > 0 && (
        <div className="space-y-1.5">
          <div className="section-label !text-[var(--rose-500)]">What's wrong</div>
          {summary.problems.slice(0, 3).map((p) => (
            <div key={p.id} className="p-2 rounded-[var(--radius-sm)] bg-[var(--rose-500)]/10 border border-[var(--rose-500)]/25">
              <div className="font-semibold text-[var(--text-primary)]">{p.kind === 'ISSUE' ? p.note : p.title}</div>
              {p.kind === 'CHECK' && p.note && <div className="text-[var(--rose-500)] mt-0.5">{p.note}</div>}
              <div className="text-[var(--text-tertiary)] mt-0.5">
                {p.status_by} · {timeAgo(p.status_at, now)}
              </div>
            </div>
          ))}
        </div>
      )}

      {summary.due.length > 0 && (
        <div className="space-y-1">
          <div className="section-label !text-[var(--orange-500)]">To do</div>
          {summary.due.slice(0, 4).map((c) => (
            <div key={c.id} className="flex items-start gap-1.5 text-[var(--text-secondary)]">
              <Clock size={12} className="text-[var(--orange-500)] mt-0.5 shrink-0" />
              <span>{c.title}</span>
            </div>
          ))}
          {summary.due.length > 4 && <div className="text-[var(--text-tertiary)]">+ {summary.due.length - 4} more</div>}
        </div>
      )}

      {summary.state === 'ok' && <div className="text-[var(--text-secondary)]">All {summary.total} checks are up to date.</div>}

      {(owners.length > 0 || locked) && (
        <div className={`flex items-start gap-1.5 ${locked ? 'text-[var(--orange-500)]' : 'text-[var(--text-secondary)]'}`}>
          {locked ? <Lock size={12} className="mt-0.5 shrink-0" /> : <Users size={12} className="mt-0.5 shrink-0" />}
          <span>
            {locked ? 'Locked for you. ' : ''}
            Responsible: {owners.length ? owners.map((o) => o.username).join(', ') : 'nobody yet'}
          </span>
        </div>
      )}

      <div className="pt-2 border-t border-[var(--border-subtle)] text-[var(--text-tertiary)] flex items-center justify-between gap-2">
        <span className="truncate">
          {last ? `${last.username} ${ACTION_TEXT[last.action]} · ${timeAgo(last.at, now)}` : 'No actions yet'}
        </span>
        <span className="text-[var(--blue-500)] font-semibold shrink-0">{locked ? 'Click to view' : 'Click to open'}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Detail sheet
// ---------------------------------------------------------------------------------------------

function MachineSheet({
  machine,
  checks,
  events,
  summary,
  isAdmin,
  owners,
  locked,
  now,
  onChanged,
  onClose,
}: {
  machine: FleetMachine;
  checks: MachineCheck[];
  events: MachineEvent[];
  summary: Summary;
  isAdmin: boolean;
  owners: MachineOwner[];
  locked: boolean;
  now: number;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [problemFor, setProblemFor] = useState<string | null>(null); // check id, or '__machine'
  const [problemText, setProblemText] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editFreq, setEditFreq] = useState<Frequency>('DAILY');
  const [newTitle, setNewTitle] = useState('');
  const [newFreq, setNewFreq] = useState<Frequency>('DAILY');
  const [picking, setPicking] = useState(false);
  const [allUsers, setAllUsers] = useState<{ id: string; username: string; role: string }[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const canAct = !locked;

  const openPicker = async () => {
    setPicked(new Set(owners.map((o) => o.user_id)));
    setPicking(true);
    if (!allUsers) {
      try {
        setAllUsers((await fetchUsers()).users);
      } catch (err: any) {
        setError(err?.message || 'Could not load the user list');
      }
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError('');
    try {
      await fn();
      await onChanged();
      return true;
    } catch (err: any) {
      setError(err?.message || 'Something went wrong');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const sendProblem = async () => {
    const text = problemText.trim();
    if (text.length < 3) return setError('Describe the problem in a few words.');
    const ok = await run(`problem:${problemFor}`, () =>
      problemFor === '__machine' ? reportIssue(machine.id, text) : checkAction(machine.id, problemFor!, 'PROBLEM', text),
    );
    if (ok) {
      setProblemFor(null);
      setProblemText('');
    }
  };

  const issues = checks.filter((c) => c.kind === 'ISSUE');
  const list = checks.filter((c) => c.kind === 'CHECK');
  const groups = (['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY'] as Frequency[])
    .map((f) => ({ f, items: list.filter((c) => c.frequency === f) }))
    .filter((g) => g.items.length);

  const problemForm = (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.22, ease: EASE_OUT }}
      className="overflow-hidden"
    >
      <div className="flex gap-2 pt-2">
        <input
          autoFocus
          className="aurora-input flex-1 text-xs"
          placeholder="What is wrong? e.g. coolant pump makes noise"
          value={problemText}
          maxLength={300}
          onChange={(e) => setProblemText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && sendProblem()}
        />
        <button className="btn-danger text-xs py-1.5 px-3" disabled={!!busy} onClick={sendProblem}>
          Send
        </button>
        <button className="btn-secondary text-xs py-1.5 px-3" onClick={() => setProblemFor(null)}>
          Cancel
        </button>
      </div>
    </motion.div>
  );

  return (
    <motion.div
      {...iosBackdrop}
      className="fixed inset-0 modal-backdrop z-[99990] flex items-center justify-center p-3 sm:p-6"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        {...iosSurface}
        role="dialog"
        aria-modal="true"
        aria-label={`${machine.id} preventive actions`}
        className="glass-modal w-full max-w-5xl max-h-[90vh] flex flex-col md:flex-row overflow-hidden"
      >
        {/* Left: the machine */}
        <div
          className={`machine-hero relative md:w-[38%] shrink-0 flex flex-col items-center justify-between p-6 gap-4 ${
            summary.state === 'problem' ? 'is-problem' : ''
          }`}
          style={{ '--accent': machine.accent } as React.CSSProperties}
        >
          <div className="self-stretch flex items-start justify-between">
            <div>
              <div className="text-2xl font-bold text-[var(--text-primary)]">{machine.id}</div>
              <div className="text-xs text-[var(--text-tertiary)]">
                {machine.brand} {machine.model}
              </div>
            </div>
            <div className="md:hidden">
              <button onClick={onClose} className="btn-icon" aria-label="Close">
                <X size={15} />
              </button>
            </div>
          </div>
          <div className="machine-viewer self-stretch">
            <motion.img
              src={machine.image}
              alt={`${machine.brand} ${machine.model}`}
              className="machine-viewer-photo"
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', duration: 0.6, bounce: 0.25 }}
            />
          </div>
          <div className="self-stretch space-y-2">
            <div
              className={`w-full justify-center py-2 text-xs ${
                summary.state === 'problem' ? 'badge-danger' : summary.state === 'due' ? 'badge-warning' : 'badge-positive'
              }`}
            >
              {summary.state === 'problem' ? (
                <>
                  <AlertTriangle size={14} /> {summary.problems.length} open problem{summary.problems.length > 1 ? 's' : ''}
                </>
              ) : summary.state === 'due' ? (
                <>
                  <Clock size={14} /> {summary.due.length} check{summary.due.length > 1 ? 's' : ''} to do
                </>
              ) : (
                <>
                  <CheckCircle2 size={14} /> All checks up to date
                </>
              )}
            </div>
            {canAct ? (
              <button
                className="btn-warning w-full text-xs py-2"
                onClick={() => {
                  setProblemFor('__machine');
                  setProblemText('');
                }}
              >
                <AlertTriangle size={14} />
                <span>Report a problem</span>
              </button>
            ) : (
              <div className="badge-warning w-full justify-center py-2 text-xs">
                <Lock size={13} /> View only
              </div>
            )}
            <AnimatePresence>{problemFor === '__machine' && problemForm}</AnimatePresence>
          </div>
        </div>

        {/* Right: problems, checklist, history */}
        <div className="flex-1 min-w-0 overflow-y-auto p-5 space-y-5 bg-[var(--bg-panel)]">
          <div className="hidden md:flex justify-end -mt-1">
            <button onClick={onClose} className="btn-icon" aria-label="Close">
              <X size={15} />
            </button>
          </div>

          {error && <div className="badge-danger w-full justify-center py-2 text-xs">{error}</div>}

          {locked && (
            <div className="p-3 rounded-[var(--radius-md)] bg-[var(--orange-500)]/10 border border-[var(--orange-500)]/30 flex items-start gap-2.5 text-xs">
              <Lock size={16} className="text-[var(--orange-500)] shrink-0 mt-0.5" />
              <div className="text-[var(--text-secondary)]">
                <b className="text-[var(--text-primary)]">{machine.id} is locked for you.</b> You are responsible for other machines.{' '}
                {owners.length ? `${owners.map((o) => o.username).join(', ')} look${owners.length === 1 ? 's' : ''} after this one.` : ''} You can see
                its status, but only they or an admin can update it.
              </div>
            </div>
          )}

          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="section-label flex items-center gap-1.5">
                <Users size={12} /> Responsible
              </div>
              {isAdmin && !picking && (
                <button className="btn-secondary text-xs py-1 px-2.5" onClick={openPicker}>
                  <Pencil size={12} />
                  <span>Choose people</span>
                </button>
              )}
            </div>
            {!picking ? (
              <div className="flex flex-wrap gap-1.5">
                {owners.length === 0 ? (
                  <span className="text-xs text-[var(--text-tertiary)]">
                    Nobody yet{isAdmin ? '. Choose who looks after this machine.' : '.'}
                  </span>
                ) : (
                  owners.map((o) => (
                    <span key={o.user_id} className="owner-chip">
                      <span className="owner-avatar">{o.username.slice(0, 2)}</span>
                      {o.username}
                    </span>
                  ))
                )}
              </div>
            ) : (
              <motion.div
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={SPRING_POP}
                className="p-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[rgba(var(--ov),0.02)] space-y-3"
              >
                <p className="text-[11px] text-[var(--text-tertiary)]">
                  People you choose here can only update the machines they are responsible for. Every other machine is locked for them.
                </p>
                {!allUsers ? (
                  <div className="text-xs text-[var(--text-tertiary)]">Loading people...</div>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {allUsers
                      .filter((u) => u.role !== 'ADMIN')
                      .map((u) => {
                        const on = picked.has(u.id);
                        return (
                          <button
                            key={u.id}
                            className={`owner-pick no-glass ${on ? 'on' : ''}`}
                            aria-pressed={on}
                            onClick={() =>
                              setPicked((prev) => {
                                const next = new Set(prev);
                                if (next.has(u.id)) next.delete(u.id);
                                else next.add(u.id);
                                return next;
                              })
                            }
                          >
                            <span className="owner-avatar">{u.username.slice(0, 2)}</span>
                            {u.username}
                            {on && <CheckCircle2 size={12} />}
                          </button>
                        );
                      })}
                  </div>
                )}
                <div className="flex gap-2 justify-end">
                  <button className="btn-secondary text-xs py-1.5 px-3" onClick={() => setPicking(false)}>
                    Cancel
                  </button>
                  <button
                    className="btn-primary text-xs py-1.5 px-3"
                    disabled={!!busy || !allUsers}
                    onClick={async () => {
                      if (await run('owners', () => setOwners(machine.id, [...picked]))) setPicking(false);
                    }}
                  >
                    Save
                  </button>
                </div>
              </motion.div>
            )}
          </section>

          {issues.length > 0 && (
            <section className="space-y-2">
              <div className="section-label !text-[var(--rose-500)]">Open problems</div>
              {issues.map((p, i) => (
                <motion.div
                  key={p.id}
                  {...waveItem(i)}
                  className="p-3 rounded-[var(--radius-md)] bg-[var(--rose-500)]/10 border border-[var(--rose-500)]/30 flex items-center gap-3"
                >
                  <AlertTriangle size={16} className="text-[var(--rose-500)] shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-[var(--text-primary)]">{p.note}</div>
                    <div className="text-[11px] text-[var(--text-tertiary)]">
                      Reported by {p.status_by} · {timeAgo(p.status_at, now)}
                    </div>
                  </div>
                  {canAct && (
                    <button className="btn-success text-xs py-1.5 px-3" disabled={!!busy} onClick={() => run(`fix:${p.id}`, () => checkAction(machine.id, p.id, 'RESOLVE'))}>
                      <CheckCircle2 size={13} />
                      <span>Fixed</span>
                    </button>
                  )}
                </motion.div>
              ))}
            </section>
          )}

          {groups.map((g) => (
            <section key={g.f} className="space-y-2">
              <div className="section-label">{FREQUENCY_LABEL[g.f]}</div>
              {g.items.map((c, i) => {
                const due = c.status !== 'PROBLEM' && isDue(c, now);
                const st = c.status === 'PROBLEM' ? 'problem' : due ? 'due' : 'ok';
                return (
                  <motion.div
                    key={c.id}
                    {...waveItem(i)}
                    className={`check-row p-3 rounded-[var(--radius-md)] border ${
                      st === 'problem'
                        ? 'bg-[var(--rose-500)]/10 border-[var(--rose-500)]/30'
                        : st === 'due'
                          ? 'bg-[var(--orange-500)]/5 border-[var(--orange-500)]/25'
                          : 'bg-[rgba(var(--ov),0.02)] border-[var(--border-subtle)]'
                    }`}
                  >
                    {editing === c.id ? (
                      <div className="flex flex-wrap gap-2 items-center">
                        <input className="aurora-input flex-1 min-w-[180px] text-xs" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
                        <select className="aurora-input text-xs" value={editFreq} onChange={(e) => setEditFreq(e.target.value as Frequency)}>
                          {Object.entries(FREQUENCY_LABEL).map(([k, v]) => (
                            <option key={k} value={k}>
                              {v}
                            </option>
                          ))}
                        </select>
                        <button
                          className="btn-primary text-xs py-1.5 px-3"
                          disabled={!!busy}
                          onClick={async () => {
                            if (await run(`edit:${c.id}`, () => updateCheck(machine.id, c.id, { title: editTitle, frequency: editFreq }))) setEditing(null);
                          }}
                        >
                          Save
                        </button>
                        <button className="btn-secondary text-xs py-1.5 px-3" onClick={() => setEditing(null)}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3">
                        <span className={`check-dot ${st}`} />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-[var(--text-primary)] font-medium">{c.title}</div>
                          {st === 'problem' ? (
                            <div className="text-[11px] text-[var(--rose-500)]">
                              {c.note} · {c.status_by}, {timeAgo(c.status_at, now)}
                            </div>
                          ) : (
                            <div className={`text-[11px] ${st === 'due' ? 'text-[var(--orange-500)]' : 'text-[var(--text-tertiary)]'}`}>
                              {c.last_done_at ? `Done ${timeAgo(c.last_done_at, now)} by ${c.last_done_by}` : 'Not done yet'}
                              {st === 'due' && c.last_done_at ? ' · due again' : ''}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {!canAct ? null : st === 'problem' ? (
                            <button className="btn-success text-xs py-1.5 px-3" disabled={!!busy} onClick={() => run(`fix:${c.id}`, () => checkAction(machine.id, c.id, 'RESOLVE'))}>
                              <CheckCircle2 size={13} />
                              <span>Fixed</span>
                            </button>
                          ) : (
                            <>
                              <button
                                className={`text-xs py-1.5 px-3 ${due ? 'btn-success' : 'btn-secondary'}`}
                                disabled={!!busy}
                                onClick={() => run(`done:${c.id}`, () => checkAction(machine.id, c.id, 'DONE'))}
                                title="I did this check"
                              >
                                <CheckCircle2 size={13} />
                                <span>{busy === `done:${c.id}` ? '...' : 'Done'}</span>
                              </button>
                              <button
                                className="btn-icon btn-icon-danger w-8 h-8"
                                title="Report a problem with this check"
                                aria-label="Report a problem"
                                onClick={() => {
                                  setProblemFor(c.id);
                                  setProblemText('');
                                }}
                              >
                                <AlertTriangle size={13} />
                              </button>
                            </>
                          )}
                          {isAdmin && (
                            <>
                              <button
                                className="btn-icon w-8 h-8"
                                title="Edit check"
                                aria-label="Edit check"
                                onClick={() => {
                                  setEditing(c.id);
                                  setEditTitle(c.title);
                                  setEditFreq(c.frequency || 'DAILY');
                                }}
                              >
                                <Pencil size={13} />
                              </button>
                              <button
                                className="btn-icon btn-icon-danger w-8 h-8"
                                title="Remove check"
                                aria-label="Remove check"
                                onClick={() => {
                                  if (confirm(`Remove "${c.title}" from ${machine.id}?`)) run(`del:${c.id}`, () => deleteCheck(machine.id, c.id));
                                }}
                              >
                                <Trash2 size={13} />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    )}
                    <AnimatePresence>{problemFor === c.id && problemForm}</AnimatePresence>
                  </motion.div>
                );
              })}
            </section>
          ))}

          {isAdmin && (
            <section className="space-y-2">
              <div className="section-label">Add a check (admin)</div>
              <div className="flex flex-wrap gap-2">
                <input
                  className="aurora-input flex-1 min-w-[200px] text-xs"
                  placeholder="e.g. Check spindle chiller level"
                  value={newTitle}
                  maxLength={160}
                  onChange={(e) => setNewTitle(e.target.value)}
                />
                <select className="aurora-input text-xs" value={newFreq} onChange={(e) => setNewFreq(e.target.value as Frequency)}>
                  {Object.entries(FREQUENCY_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
                <button
                  className="btn-primary text-xs py-1.5 px-3"
                  disabled={!!busy || newTitle.trim().length < 3}
                  onClick={async () => {
                    if (await run('add', () => createCheck(machine.id, newTitle.trim(), newFreq))) setNewTitle('');
                  }}
                >
                  <Plus size={13} />
                  <span>Add</span>
                </button>
              </div>
            </section>
          )}

          <section className="space-y-2">
            <div className="section-label flex items-center gap-1.5">
              <HistoryIcon size={12} /> History
            </div>
            {events.length === 0 ? (
              <div className="text-xs text-[var(--text-tertiary)]">Nothing recorded yet.</div>
            ) : (
              <div className="space-y-1">
                {events.map((e) => (
                  <div key={e.id} className="flex items-start gap-2 text-xs">
                    <span
                      className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${
                        e.action === 'PROBLEM' ? 'bg-[var(--rose-500)]' : e.action === 'DONE' || e.action === 'RESOLVE' ? 'bg-[var(--green-500)]' : 'bg-[var(--text-tertiary)]'
                      }`}
                    />
                    <span className="text-[var(--text-secondary)] flex-1">
                      <b className="text-[var(--text-primary)]">{e.username}</b> {ACTION_TEXT[e.action]}
                      {e.check_title && e.action !== 'PROBLEM' ? ` "${e.check_title}"` : ''}
                      {e.note ? `: ${e.note}` : ''}
                    </span>
                    <span className="text-[var(--text-tertiary)] shrink-0">{timeAgo(e.at, now)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <div className="text-[11px] text-[var(--text-tertiary)] flex items-center gap-1.5">
            <Wrench size={12} /> Everyone can mark checks done and report or fix problems. Changes appear on every PC within seconds.
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
