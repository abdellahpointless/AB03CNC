import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Flag,
  Lock,
  History as HistoryIcon,
  Monitor,
  OctagonX,
  Pencil,
  Plus,
  QrCode,
  RefreshCw,
  Trash2,
  Users,
  Wrench,
  X,
} from 'lucide-react';
import StatusBoard from './StatusBoard';
import MachineQrSheet from './MachineQrSheet';
import CalesBox from './CalesBox';
import ViseCheck from './ViseCheck';
import { fmtDuration } from '../i18n/format';
import { useAuth } from '../contexts/AuthContext';
import { useSync } from '../contexts/SyncContext';
import {
  toFleet,
  machineSubtitle,
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
  endTaskWaiting,
  machineSummary,
  reportIssue,
  reportMissed,
  setOwners,
  setStops,
  timeAgo,
  updateCheck,
} from '../lib/fleet';
import { EASE_OUT, SPRING_POP, iosBackdrop, iosSurface, waveItem } from '../lib/motion';
import { calesOf, viseId, type CalesState } from '../lib/cales';
import { currentRegion } from '../lib/instance';
import { periodKey, shiftOf, shiftStart } from '../lib/shifts';
import i18n, { useT } from '../i18n';

type Summary = ReturnType<typeof machineSummary>;
type Loaded = Awaited<ReturnType<typeof fetchMachines>>;
/** My own part of the data (checks I did this period, boxes I confirmed this shift) and the cales boxes. */
type Mine = Pick<Loaded, 'myDone' | 'cales' | 'calesChecked' | 'calesRequests' | 'prevShift'> & { skew: number };
const SHIFT_HOURS: Record<string, string> = { S1: '08:00–16:00', S2: '16:00–24:00', S3: '00:00–08:00' };

/** Translation key of what a person did ("marked done", "reported a problem", ...). */
const actionKey = (action: MachineEvent['action']) => `events.${action}` as const;

export default function PreventiveActions() {
  const { t } = useT('preventive');
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const { versions, machines, machinesLoaded, connection, lastSyncAt, features } = useSync();
  const shifts = features.shiftChecks;
  const [board, setBoard] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  // The TV board takes the whole screen (full screen when the browser allows it).
  const openBoard = () => {
    document.documentElement.requestFullscreen?.().catch(() => undefined);
    setBoard(true);
  };
  const closeBoard = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    setBoard(false);
  }, []);
  const [checks, setChecks] = useState<MachineCheck[] | null>(null);
  const [events, setEvents] = useState<MachineEvent[]>([]);
  const [owners, setOwnerRows] = useState<MachineOwner[]>([]);
  const [mine, setMine] = useState<Mine>({ myDone: [], cales: [], calesChecked: [], calesRequests: [], prevShift: { key: '', done: [], people: [] }, skew: 0 });
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<{ id: string; above: boolean } | null>(null);
  const [show, setShow] = useState<'down' | 'problem' | 'due' | 'ok' | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      const res = await fetchMachines();
      setChecks(res.checks);
      setEvents(res.events);
      setOwnerRows(res.owners || []);
      setMine({ myDone: res.myDone, cales: res.cales, calesChecked: res.calesChecked, calesRequests: res.calesRequests, prevShift: res.prevShift, skew: res.serverTime - Date.now() });
      setLoadError('');
    } catch (err: any) {
      setLoadError(err?.message || i18n.t('preventive:errors.loadMachines'));
    }
  }, []);

  // Reload whenever any PC changes something (versions.machines is bumped by the server), and when a
  // new shift starts (by the server's clock): what is mine to do starts again.
  const shiftKey = shiftOf(now + mine.skew, currentRegion().timeZone).key;
  useEffect(() => {
    load();
  }, [load, versions.machines, shiftKey]);

  // "Due" depends on the clock (a daily check becomes due again at midnight).
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const allFleet = useMemo(() => toFleet(machines), [machines]);
  const myMachines = useMemo(() => (user ? owners.filter((o) => o.user_id === user.id).map((o) => o.machine_id) : []), [owners, user]);
  // Someone who looks after machines sees only those; admins and people without a machine see all.
  const fleet = useMemo(
    () => (user?.role !== 'ADMIN' && myMachines.length ? allFleet.filter((m) => myMachines.includes(m.id)) : allFleet),
    [allFleet, myMachines, user],
  );

  const byMachine = useMemo(() => {
    const map = new Map<string, MachineCheck[]>();
    for (const m of fleet) map.set(m.id, []);
    for (const c of checks || []) map.get(c.machine_id)?.push(c);
    return map;
  }, [checks, fleet]);

  const summaries = useMemo(() => {
    const out = new Map<string, Summary>();
    for (const m of fleet) out.set(m.id, machineSummary(byMachine.get(m.id) || [], now));
    return out;
  }, [byMachine, now, fleet]);

  const counts = useMemo(() => {
    let problem = 0, due = 0, ok = 0, down = 0;
    for (const s of summaries.values()) {
      s.state === 'problem' ? problem++ : s.state === 'due' ? due++ : ok++;
      if (s.down) down++;
    }
    return { problem, due, ok, down };
  }, [summaries]);

  const ownersOf = useCallback((id: string) => owners.filter((o) => o.machine_id === id), [owners]);
  const lastEvent = useCallback((id: string) => events.find((e) => e.machine_id === id), [events]);
  const selectedMachine = fleet.find((m) => m.id === selected) || null;
  const nameOf = (id: string) => fleet.find((m) => m.id === id)?.name ?? id;

  return (
    <div className="flex flex-col space-y-5 max-w-7xl mx-auto w-full pb-20">
      {/* Header */}
      <div className="aurora-card aurora-card-static p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-[var(--radius-md)] bg-[var(--blue-500)]/15 border border-[var(--blue-500)]/30 flex items-center justify-center text-[var(--blue-text)] shrink-0">
            <Activity size={20} />
          </div>
          <div>
            <h2 className="text-lg font-bold text-[var(--text-primary)]">{t('header.title')}</h2>
            <p className="text-xs text-[var(--text-secondary)]">
              {t('header.subtitle')}
            </p>
          </div>
        </div>
        {/* One row: what is going on, then small action bubbles that open when pointed at. */}
        <div className="flex items-center gap-2 flex-wrap md:justify-end">
          {myMachines.length > 0 && !isAdmin && (
            <span className="badge-neutral" title={t('header.myMachinesTitle')}>
              <Wrench size={13} /> {t('header.myMachines', { names: myMachines.map(nameOf).join(', ') })}
            </span>
          )}
          {/* Each count also filters the floor to those machines (pressed again: all machines). */}
          {(
            [
              ['down', counts.down, 'badge-danger', <OctagonX size={13} />, t('header.stopped', { count: counts.down })],
              ['problem', counts.problem, counts.problem ? 'badge-warning' : 'badge-neutral', <AlertTriangle size={13} />, t('header.withProblem', { count: counts.problem })],
              ['due', counts.due, 'badge-neutral', <Clock size={13} />, t('header.checksToDo', { count: counts.due })],
              ['ok', counts.ok, 'badge-positive', <CheckCircle2 size={13} />, t('header.allGood', { count: counts.ok })],
            ] as const
          )
            .filter(([k, n]) => k !== 'down' || n > 0)
            .map(([k, n, cls, icon, label]) => (
              <button
                key={k}
                type="button"
                className={`${cls} chip-filter no-glass`}
                aria-pressed={show === k}
                disabled={!n}
                title={t('header.filterTitle')}
                onClick={() => setShow(show === k ? null : k)}
              >
                {icon} {label}
              </button>
            ))}
          <span className="w-px h-4 bg-[var(--border-subtle)] mx-0.5" aria-hidden="true" />
          <button onClick={openBoard} className="pill-action no-glass" title={t('header.boardTitle')} disabled={!fleet.length}>
            <Monitor size={13} />
            <span className="pill-label">{t('header.board')}</span>
          </button>
          {isAdmin && (
            <button onClick={() => setQrOpen(true)} className="pill-action no-glass" title={t('header.qrTitle')} disabled={!fleet.length}>
              <QrCode size={13} />
              <span className="pill-label">{t('header.qr')}</span>
            </button>
          )}
          <button onClick={load} className="pill-action icon-pill no-glass">
            <RefreshCw size={13} />
            <span className="pill-label">{t('common:actions.refresh')}</span>
          </button>
        </div>
      </div>

      {loadError && <div className="badge-danger w-full justify-center py-2 text-xs">{loadError}</div>}

      {/* Machine floor */}
      <div className="machine-floor grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-5 gap-y-8 pt-2">
        {machinesLoaded && fleet.length === 0 && (
          <div className="col-span-full aurora-card aurora-card-static p-8 text-center text-sm text-[var(--text-secondary)]">
            {t('empty.none')} {isAdmin ? t('empty.adminHint') : t('empty.userHint')}
          </div>
        )}
        {fleet
          .filter((m) => {
            const s = summaries.get(m.id)!;
            return !show || (show === 'down' ? s.down : s.state === show);
          })
          .map((m, i) => (
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
            checks={byMachine.get(m.id) || []}
            cales={
              shifts
                ? { state: calesOf(mine.cales, m.id), checked: mine.calesChecked.includes(m.id), requested: mine.calesRequests.filter((r) => r.machine_id === m.id).map((r) => r.height) }
                : null
            }
            onChanged={load}
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
                events={events.filter((e) => e.machine_id === selectedMachine.id)}
                summary={summaries.get(selectedMachine.id)!}
                isAdmin={isAdmin}
                owners={ownersOf(selectedMachine.id)}
                locked={isLockedFor(selectedMachine.id, user, owners)}
                now={now}
                myDone={mine.myDone}
                prevShift={mine.prevShift}
                onChanged={load}
                onClose={() => setSelected(null)}
              />
            )}
            {board && (
              <StatusBoard
                key="board"
                fleet={fleet}
                summaries={summaries}
                now={now}
                offline={connection === 'offline'}
                updatedAt={lastSyncAt}
                onClose={closeBoard}
              />
            )}
            {qrOpen && <MachineQrSheet key="qr" machines={fleet} onClose={() => setQrOpen(false)} />}
          </AnimatePresence>,
          document.body,
        )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Machine card on the floor
// ---------------------------------------------------------------------------------------------

const CAN_HOVER = typeof window !== 'undefined' && window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;

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
  checks,
  cales,
  onChanged,
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
  /** This machine's checks and open problems (the vise report is one of them). */
  checks: MachineCheck[];
  /** The cales box, when shift checks are on. */
  cales: { state: CalesState; checked: boolean; requested: number[] } | null;
  onChanged: () => Promise<void>;
}) {
  const { t } = useT('preventive');
  const ref = useRef<HTMLDivElement>(null);
  const state = loading ? 'loading' : summary.down ? 'down' : summary.state;
  // The vise and the cales come out of the machine's side when it is pointed at; they stay while one is open.
  const [left, setLeft] = useState(false);
  const [viseOpen, setViseOpen] = useState(false);
  const [calesOpen, setCalesOpen] = useState(false);
  const sideShown = !loading && (!!hovered || viseOpen || calesOpen);

  const enter = () => {
    const r = ref.current?.getBoundingClientRect();
    const above = r ? window.innerHeight - r.bottom < 300 && r.top > 300 : false;
    if (r) setLeft(r.right + 190 > window.innerWidth);
    onHover({ id: machine.id, above });
  };
  const side = (
    <>
      <ViseCheck machine={machine} checks={checks} canAct={!locked} onChanged={onChanged} onOpenChange={setViseOpen} />
      {cales && (
        <CalesBox machine={machine} canAct={!locked} state={cales.state} checked={cales.checked} requested={cales.requested} onChanged={onChanged} onOpenChange={setCalesOpen} />
      )}
    </>
  );

  // At rest the card already says whether the vise and the cales box are fine.
  const viseBad = checks.some((c) => c.id === viseId(machine.id));
  const calesPairs = cales ? Object.values(cales.state) : [];
  const calesTone = !cales ? null : calesPairs.some((p) => p.status === 'missing') ? 'bad' : calesPairs.length ? 'warn' : 'ok';
  const kit = `${t('vise.title')}: ${viseBad ? t('vise.damaged') : t('vise.good')}${calesTone ? `, ${t('cales.title')}: ${t(`card.kit.${calesTone}`)}` : ''}`;

  const label =
    state === 'down'
      ? t('status.stopped')
      : state === 'problem'
      ? t('status.problems', { count: summary.problems.length })
      : state === 'due'
        ? t('status.checksToDo', { count: summary.due.length })
        : state === 'ok'
          ? t('status.allGood')
          : '...';

  return (
    <motion.div
      {...waveItem(index)}
      className={`relative machine-slot ${sideShown ? `is-active side-${left ? 'left' : 'right'}` : ''}`}
      // A tap on a phone also sends a mouse "enter": only devices that can point open the pop-up.
      onMouseEnter={CAN_HOVER ? enter : undefined}
      onMouseLeave={() => onHover(null)}
      // Keyboard focus opens it like pointing does; a tap (phones) and the vise / cales windows do not.
      onFocus={(e) => e.currentTarget.contains(e.target) && e.target.matches(':focus-visible') && enter()}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && onHover(null)}
    >
      {/* The card and, when pointed at, the vise / cales panel joined to its border: they lift together. */}
      <motion.div className="relative" animate={CAN_HOVER && sideShown ? { y: -10, scale: 1.035 } : { y: 0, scale: 1 }} transition={SPRING_POP}>
      <motion.div
        ref={ref}
        role="button"
        tabIndex={0}
        aria-label={`${t('card.ariaLabel', { name: machine.name, subtitle: machineSubtitle(machine), status: label })}. ${kit}`}
        data-state={state}
        data-locked={locked ? 'true' : undefined}
        className="machine-card"
        style={{ '--accent': machine.accent } as React.CSSProperties}
        whileTap={{ scale: 0.985 }}
        transition={SPRING_POP}
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
            <span className="machine-lock" title={t('card.lockedTitle')} aria-hidden>
              <Lock size={12} />
            </span>
          )}
          {(state === 'problem' || state === 'down') && (
            <span className={`machine-alert ${state === 'problem' ? 'is-problem' : ''}`} aria-hidden>
              {state === 'down' ? <OctagonX size={14} /> : <AlertTriangle size={14} />}
            </span>
          )}
        </div>
        <div className="flex items-end justify-between gap-2 px-4 pb-4 pt-1 machine-label">
          <div className="min-w-0">
            <div className="text-[15px] font-bold text-[var(--text-primary)] leading-tight">{machine.name}</div>
            <div className="text-xs text-[var(--text-tertiary)] truncate">
              {machineSubtitle(machine)}
            </div>
          </div>
          <span
            className={`shrink-0 text-xs py-0.5 px-2 ${
              state === 'down' ? 'badge-danger' : state === 'problem' ? 'badge-warning' : state === 'ok' ? 'badge-positive' : 'badge-neutral'
            }`}
          >
            {label}
          </span>
        </div>
        {!loading && (
          <div className="machine-kit" aria-hidden>
            <span className={viseBad ? 'tone-bad' : 'tone-ok'}>
              <i className="cales-dot" />
              {t('vise.title')}
            </span>
            {calesTone && (
              <span className={`tone-${calesTone}`}>
                <i className="cales-dot" />
                {t('cales.title')}
              </span>
            )}
          </div>
        )}
        {(owners.length > 0 || locked) && (
          <div className="machine-owners">
            {locked ? <Lock size={11} className="shrink-0" /> : <Users size={11} className="shrink-0" />}
            <span className="truncate">
              {mine ? t('card.you') + (owners.length > 1 ? ` + ${owners.length - 1}` : '') : owners.map((o) => o.username).join(', ') || t('card.nobodyAssigned')}
            </span>
          </div>
        )}
      </motion.div>

      <AnimatePresence>
        {CAN_HOVER && sideShown && (
          <motion.div
            key="side"
            // Slides out from under the card's edge and becomes part of its border.
            initial={{ opacity: 0, x: left ? 48 : -48 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: left ? 48 : -48, transition: { duration: 0.22, ease: EASE_OUT } }}
            transition={{ type: 'spring', duration: 0.5, bounce: 0 }}
            data-state={state}
            style={{ '--accent': machine.accent } as React.CSSProperties}
            className={`machine-side ${left ? 'on-left' : 'on-right'}`}
          >
            {side}
          </motion.div>
        )}
      </AnimatePresence>
      </motion.div>

      {/* Phones and tablets cannot point: the vise and the cales sit under the machine instead. */}
      {!CAN_HOVER && !loading && <div className="machine-side-row">{side}</div>}

      {/* "What's going on" pop-up */}
      <AnimatePresence>
        {hovered && !loading && (
          <motion.div
            key="pop"
            initial={{ opacity: 0, scale: 0.85, y: hovered.above ? 8 : -8, filter: 'blur(6px)' }}
            animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)', transitionEnd: { filter: 'none' } }}
            exit={{ opacity: 0, scale: 0.85, y: hovered.above ? 8 : -8, filter: 'blur(4px)', transition: { duration: 0.14, ease: EASE_OUT } }}
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
  const { t } = useT('preventive');
  return (
    <div className="p-4 space-y-3 text-xs relative z-10">
      <div className="flex items-center justify-between">
        <span className="font-bold text-sm text-[var(--text-primary)]">
          {machine.name} <span className="text-[var(--text-tertiary)] font-normal">· {machine.model}</span>
        </span>
        {summary.state === 'ok' && <CheckCircle2 size={16} className="text-[var(--green-500)]" />}
      </div>

      {summary.problems.length > 0 && (
        <div className="space-y-1.5">
          <div className="section-label !text-[var(--rose-500)]">{t('pop.whatsWrong')}</div>
          {summary.problems.slice(0, 3).map((p) => (
            <div key={p.id} className="p-2 rounded-[var(--radius-sm)] bg-[var(--rose-500)]/10 border border-[var(--rose-500)]/25">
              {!!p.stops && (
                <div className="text-xs font-bold uppercase tracking-wide text-[var(--rose-text)] flex items-center gap-1 mb-0.5">
                  <OctagonX size={11} /> {t('stop.badge')}
                </div>
              )}
              <div className="font-semibold text-[var(--text-primary)]">{p.kind === 'ISSUE' ? p.note : p.title}</div>
              {p.kind === 'CHECK' && p.note && <div className="text-[var(--rose-text)] mt-0.5">{p.note}</div>}
              <div className="text-[var(--text-secondary)] mt-0.5">
                {p.status_by} · {timeAgo(p.status_at, now)}
              </div>
            </div>
          ))}
        </div>
      )}

      {summary.due.length > 0 && (
        <div className="space-y-1">
          <div className="section-label !text-[var(--orange-text)]">{t('pop.toDo')}</div>
          {summary.due.slice(0, 4).map((c) => (
            <div key={c.id} className="flex items-start gap-1.5 text-[var(--text-secondary)]">
              <Clock size={12} className="text-[var(--orange-text)] mt-0.5 shrink-0" />
              <span>{c.title}</span>
            </div>
          ))}
          {summary.due.length > 4 && <div className="text-[var(--text-tertiary)]">{t('pop.more', { count: summary.due.length - 4 })}</div>}
        </div>
      )}

      {summary.state === 'ok' && <div className="text-[var(--text-secondary)]">{t('pop.allChecksUpToDate', { total: summary.total })}</div>}

      {(owners.length > 0 || locked) && (
        <div className={`flex items-start gap-1.5 ${locked ? 'text-[var(--orange-text)]' : 'text-[var(--text-secondary)]'}`}>
          {locked ? <Lock size={12} className="mt-0.5 shrink-0" /> : <Users size={12} className="mt-0.5 shrink-0" />}
          <span>
            {locked ? `${t('pop.lockedForYou')} ` : ''}
            {t('pop.responsible', { names: owners.length ? owners.map((o) => o.username).join(', ') : t('pop.nobodyYet') })}
          </span>
        </div>
      )}

      <div className="pt-2 border-t border-[var(--border-subtle)] text-[var(--text-tertiary)] flex items-center justify-between gap-2">
        <span className="truncate">
          {last ? `${last.username} ${t(actionKey(last.action), { users: last.note })} · ${timeAgo(last.at, now)}` : t('pop.noActions')}
        </span>
        <span className="text-[var(--blue-text)] font-semibold shrink-0">{locked ? t('pop.clickToView') : t('pop.clickToOpen')}</span>
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
  myDone,
  prevShift,
  onChanged,
  onClose,
}: {
  machine: FleetMachine;
  checks: MachineCheck[];
  /** This machine's events, newest first. */
  events: MachineEvent[];
  summary: Summary;
  isAdmin: boolean;
  owners: MachineOwner[];
  locked: boolean;
  now: number;
  /** Checks I did myself in their current period. */
  myDone: string[];
  prevShift: Mine['prevShift'];
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useT('preventive');
  const shifts = useSync().features.shiftChecks;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [problemFor, setProblemFor] = useState<string | null>(null); // check id, or '__machine'
  const [problemText, setProblemText] = useState('');
  const [problemStops, setProblemStops] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editFreq, setEditFreq] = useState<Frequency>('DAILY');
  const [newTitle, setNewTitle] = useState('');
  const [newFreq, setNewFreq] = useState<Frequency>('SHIFT_START');
  const [picking, setPicking] = useState(false);
  const [allUsers, setAllUsers] = useState<{ id: string; username: string; role: string }[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const canAct = !locked;
  /** Everyone does every check in its period themselves; admins see whether anyone did it. */
  const dueFor = (c: MachineCheck) =>
    c.kind === 'CHECK' && !!c.frequency && c.status !== 'PROBLEM' && !endTaskWaiting(c, now) && (shifts && canAct && !isAdmin ? !myDone.includes(c.id) : isDue(c, now));
  const toDo = checks.filter(dueFor).length;
  const tz = currentRegion().timeZone;
  /** Start / end of shift tasks, and who worked on this machine in the previous shift (to report). */
  const shiftTasks = checks.filter((c) => c.kind === 'CHECK' && (c.frequency === 'SHIFT_START' || c.frequency === 'SHIFT_END'));
  const workedPrev = [...new Set(prevShift.people.filter((p) => p.machine_id === machine.id).map((p) => p.username))];
  /** Who said this check was OK in the same period, before this problem was reported. */
  const saidOk = (e: MachineEvent, i: number) => {
    const f = shifts && e.action === 'PROBLEM' && e.check_id ? checks.find((c) => c.id === e.check_id)?.frequency : null;
    if (!f) return null;
    const p = periodKey(f, e.at, tz);
    // shortcut: only the events loaded (the latest 300 of all machines), enough for a day of checks.
    return events.slice(i + 1).find((o) => o.check_id === e.check_id && o.action === 'DONE' && o.username !== e.username && periodKey(f, o.at, tz) === p)?.username ?? null;
  };

  const openPicker = async () => {
    setPicked(new Set(owners.map((o) => o.user_id)));
    setPicking(true);
    if (!allUsers) {
      try {
        setAllUsers((await fetchUsers()).users);
      } catch (err: any) {
        setError(err?.message || t('errors.loadUsers'));
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
      setError(err?.message || t('common:errors.generic'));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const sendProblem = async () => {
    const text = problemText.trim();
    if (text.length < 3) return setError(t('errors.describeProblem'));
    const ok = await run(`problem:${problemFor}`, () =>
      problemFor === '__machine' ? reportIssue(machine.id, text, problemStops) : checkAction(machine.id, problemFor!, 'PROBLEM', text, problemStops),
    );
    if (ok) {
      setProblemFor(null);
      setProblemText('');
      setProblemStops(false);
    }
  };

  const issues = checks.filter((c) => c.kind === 'ISSUE');
  const list = checks.filter((c) => c.kind === 'CHECK');
  const groups = (Object.keys(FREQUENCY_LABEL) as Frequency[])
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
          placeholder={t('problem.placeholder')}
          value={problemText}
          maxLength={300}
          onChange={(e) => setProblemText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && sendProblem()}
        />
        <button className="btn-danger text-xs py-1.5 px-3" disabled={!!busy} onClick={sendProblem}>
          {t('problem.send')}
        </button>
        <button className="btn-secondary text-xs py-1.5 px-3" onClick={() => setProblemFor(null)}>
          {t('common:actions.cancel')}
        </button>
      </div>
      <label className={`stop-check ${problemStops ? 'on' : ''}`}>
        <input type="checkbox" checked={problemStops} onChange={(e) => setProblemStops(e.target.checked)} />
        <OctagonX size={14} />
        <span>{t('problem.stops')}</span>
      </label>
    </motion.div>
  );

  /** "It stops the machine" / "Machine runs again" on an open problem. */
  const stopToggle = (p: MachineCheck) =>
    canAct ? (
      <button
        className={`text-xs py-1.5 px-3 ${p.stops ? 'btn-secondary' : 'btn-danger'}`}
        disabled={!!busy}
        onClick={() => run(`stops:${p.id}`, () => setStops(machine.id, p.id, !p.stops))}
      >
        <OctagonX size={13} />
        <span>{p.stops ? t('stop.markRunning') : t('stop.markStopped')}</span>
      </button>
    ) : null;
  const stopBadge = (p: MachineCheck) =>
    p.stops ? (
      <span className="badge-danger text-xs py-0.5 px-2 mt-1 inline-flex">
        <OctagonX size={11} /> {t('stop.since', { time: fmtDuration((now - (p.status_at ?? now)) / 1000) })}
      </span>
    ) : null;

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
        aria-label={t('sheet.ariaLabel', { name: machine.name })}
        className="glass-modal w-full max-w-5xl max-h-[90vh] flex flex-col md:flex-row overflow-hidden"
      >
        {/* Left: the machine */}
        <div
          className={`machine-hero relative md:w-[38%] shrink-0 flex flex-col items-center justify-between p-6 gap-4 ${
            summary.down ? 'is-problem is-down' : summary.state === 'problem' ? 'is-problem' : ''
          }`}
          style={{ '--accent': machine.accent } as React.CSSProperties}
        >
          <div className="self-stretch flex items-start justify-between">
            <div>
              <div className="text-2xl font-bold text-[var(--text-primary)]">{machine.name}</div>
              <div className="text-xs text-[var(--text-tertiary)]">
                {machineSubtitle(machine)}
              </div>
            </div>
            <div className="md:hidden">
              <button onClick={onClose} className="btn-icon" aria-label={t('common:actions.close')}>
                <X size={15} />
              </button>
            </div>
          </div>
          <div className="machine-viewer self-stretch">
            <motion.img
              src={machine.image}
              alt={machineSubtitle(machine)}
              className="machine-viewer-photo"
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', duration: 0.6, bounce: 0.25 }}
            />
          </div>
          <div className="self-stretch space-y-2">
            {summary.down && (
              <div className="badge-danger w-full justify-center py-2 text-xs font-bold machine-stopped-badge">
                <OctagonX size={14} /> {t('stop.badge')}
              </div>
            )}
            <div
              className={`w-full justify-center py-2 text-xs ${
                summary.state === 'problem' ? 'badge-danger' : toDo ? 'badge-warning' : 'badge-positive'
              }`}
            >
              {summary.state === 'problem' ? (
                <>
                  <AlertTriangle size={14} /> {t('status.openProblems', { count: summary.problems.length })}
                </>
              ) : toDo ? (
                <>
                  <Clock size={14} /> {t('status.checksToDo', { count: toDo })}
                </>
              ) : (
                <>
                  <CheckCircle2 size={14} /> {t('status.allUpToDate')}
                </>
              )}
            </div>
            {canAct ? (
              <button
                className="btn-warning w-full text-xs py-2"
                onClick={() => {
                  setProblemFor('__machine');
                  setProblemText('');
                  setProblemStops(false);
                }}
              >
                <AlertTriangle size={14} />
                <span>{t('sheet.reportProblem')}</span>
              </button>
            ) : (
              <div className="badge-warning w-full justify-center py-2 text-xs">
                <Lock size={13} /> {t('sheet.viewOnly')}
              </div>
            )}
            <AnimatePresence>{problemFor === '__machine' && problemForm}</AnimatePresence>
          </div>
        </div>

        {/* Right: problems, checklist, history */}
        <div className="flex-1 min-w-0 overflow-y-auto p-5 space-y-5 bg-[var(--bg-panel)]">
          <div className="hidden md:flex justify-end -mt-1">
            <button onClick={onClose} className="btn-icon" aria-label={t('common:actions.close')}>
              <X size={15} />
            </button>
          </div>

          {error && <div className="badge-danger w-full justify-center py-2 text-xs">{error}</div>}

          {locked && (
            <div className="p-3 rounded-[var(--radius-md)] bg-[var(--orange-500)]/10 border border-[var(--orange-500)]/30 flex items-start gap-2.5 text-xs">
              <Lock size={16} className="text-[var(--orange-text)] shrink-0 mt-0.5" />
              <div className="text-[var(--text-secondary)]">
                <b className="text-[var(--text-primary)]">{t('locked.title', { name: machine.name })}</b> {t('locked.otherMachines')}{' '}
                {owners.length ? t('locked.owners', { count: owners.length, names: owners.map((o) => o.username).join(', ') }) : ''} {t('locked.canSee')}
              </div>
            </div>
          )}

          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="section-label flex items-center gap-1.5">
                <Users size={12} /> {t('owners.title')}
              </div>
              {isAdmin && !picking && (
                <button className="btn-secondary text-xs py-1 px-2.5 whitespace-nowrap shrink-0" onClick={openPicker}>
                  <Pencil size={12} />
                  <span>{t('owners.choose')}</span>
                </button>
              )}
            </div>
            {!picking ? (
              <div className="flex flex-wrap gap-1.5">
                {owners.length === 0 ? (
                  <span className="text-xs text-[var(--text-tertiary)]">
                    {isAdmin ? t('owners.nobodyYetAdmin') : t('owners.nobodyYet')}
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
                <p className="text-xs text-[var(--text-tertiary)]">
                  {t('owners.pickerHelp')}
                </p>
                {!allUsers ? (
                  <div className="text-xs text-[var(--text-tertiary)]">{t('owners.loading')}</div>
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
                    {t('common:actions.cancel')}
                  </button>
                  <button
                    className="btn-primary text-xs py-1.5 px-3"
                    disabled={!!busy || !allUsers}
                    onClick={async () => {
                      if (await run('owners', () => setOwners(machine.id, [...picked]))) setPicking(false);
                    }}
                  >
                    {t('common:actions.save')}
                  </button>
                </div>
              </motion.div>
            )}
          </section>

          {issues.length > 0 && (
            <section className="space-y-2">
              <div className="section-label !text-[var(--rose-500)]">{t('problem.openTitle')}</div>
              {issues.map((p, i) => (
                <motion.div
                  key={p.id}
                  {...waveItem(i)}
                  className="p-3 rounded-[var(--radius-md)] bg-[var(--rose-500)]/10 border border-[var(--rose-500)]/30 flex flex-wrap items-center gap-3"
                >
                  {p.stops ? <OctagonX size={16} className="text-[var(--rose-500)] shrink-0" /> : <AlertTriangle size={16} className="text-[var(--rose-500)] shrink-0" />}
                  <div className="flex-1 min-w-[10rem]">
                    <div className="text-sm font-semibold text-[var(--text-primary)]">{p.note}</div>
                    <div className="text-xs text-[var(--text-secondary)]">
                      {t('problem.reportedBy', { user: p.status_by, time: timeAgo(p.status_at, now) })}
                    </div>
                    {stopBadge(p)}
                  </div>
                  <div className="flex flex-wrap gap-2 ml-auto">
                    {stopToggle(p)}
                    {canAct && (
                      <button className="btn-success text-xs py-1.5 px-3" disabled={!!busy} onClick={() => run(`fix:${p.id}`, () => checkAction(machine.id, p.id, 'RESOLVE'))}>
                        <CheckCircle2 size={13} />
                        <span>{t('problem.fixed')}</span>
                      </button>
                    )}
                  </div>
                </motion.div>
              ))}
            </section>
          )}

          {shifts && canAct && shiftTasks.length > 0 && prevShift.key && (
            <section className="space-y-2">
              <div className="section-label">{t('prev.title', { hours: SHIFT_HOURS[prevShift.key.slice(-2)] })}</div>
              <p className="text-xs text-[var(--text-tertiary)]">{t('prev.hint')}</p>
              {shiftTasks.map((c) => {
                const by = prevShift.done.filter((d) => d.check_id === c.id).map((d) => d.username);
                const reported = events.some((e) => e.action === 'MISSED' && e.check_id === c.id && e.at >= shiftStart(now, tz));
                const users = (by.length ? by : workedPrev).join(', ');
                return (
                  <div key={c.id} className="flex items-center gap-2 p-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[rgba(var(--ov),0.02)]">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-[var(--text-primary)]">{c.title}</div>
                      <div className={`text-xs ${by.length ? 'text-[var(--text-tertiary)]' : 'text-[var(--orange-text)]'}`}>
                        {FREQUENCY_LABEL[c.frequency!]} ·{' '}
                        {by.length ? t('prev.doneBy', { users }) : users ? t('prev.notDone', { users }) : t('prev.nobody')}
                      </div>
                    </div>
                    {reported ? (
                      <span className="badge-warning shrink-0">
                        <Flag size={12} /> {t('prev.reported')}
                      </span>
                    ) : (
                      users && (
                        <button
                          className="btn-secondary text-xs py-1.5 px-3 shrink-0"
                          disabled={!!busy}
                          title={t('prev.reportTitle', { users })}
                          onClick={() => run(`missed:${c.id}`, () => reportMissed(machine.id, c.id))}
                        >
                          <Flag size={13} />
                          <span>{t('prev.report')}</span>
                        </button>
                      )
                    )}
                  </div>
                );
              })}
            </section>
          )}

          {groups.map((g) => (
            <section key={g.f} className="space-y-2">
              <div className="section-label">{FREQUENCY_LABEL[g.f]}</div>
              {g.items.map((c, i) => {
                const due = dueFor(c);
                const st = c.status === 'PROBLEM' ? 'problem' : due ? 'due' : endTaskWaiting(c, now) ? 'later' : 'ok';
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
                        <input className="aurora-input flex-1 min-w-[180px] text-xs" aria-label={t('common:a11y.checkTitle')} value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
                        <select className="aurora-input text-xs" aria-label={t('common:a11y.frequency')} value={editFreq} onChange={(e) => setEditFreq(e.target.value as Frequency)}>
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
                          {t('common:actions.save')}
                        </button>
                        <button className="btn-secondary text-xs py-1.5 px-3" onClick={() => setEditing(null)}>
                          {t('common:actions.cancel')}
                        </button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-3">
                        <span className={`check-dot ${st}`} />
                        <div className="flex-1 min-w-[10rem]">
                          <div className="text-sm text-[var(--text-primary)] font-medium">{c.title}</div>
                          {st === 'problem' ? (
                            <>
                              <div className="text-xs text-[var(--rose-500)]">
                                {c.note} · {c.status_by}, {timeAgo(c.status_at, now)}
                              </div>
                              {stopBadge(c)}
                            </>
                          ) : (
                            <div className={`text-xs ${st === 'due' ? 'text-[var(--orange-text)]' : 'text-[var(--text-secondary)]'}`}>
                              {endTaskWaiting(c, now) ? t('check.endLater') : c.last_done_at ? t('check.doneBy', { time: timeAgo(c.last_done_at, now), user: c.last_done_by }) : t('check.notDone')}
                              {st === 'due' && c.last_done_at ? ` · ${isDue(c, now) ? t('check.dueAgain') : t('check.youToo')}` : ''}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0 ml-auto">
                          {!canAct ? null : st === 'problem' ? (
                            <>
                              {stopToggle(c)}
                              <button className="btn-success text-xs py-1.5 px-3" disabled={!!busy} onClick={() => run(`fix:${c.id}`, () => checkAction(machine.id, c.id, 'RESOLVE'))}>
                                <CheckCircle2 size={13} />
                                <span>{t('problem.fixed')}</span>
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                className={`text-xs py-1.5 px-3 ${due ? 'btn-success' : 'btn-secondary'}`}
                                disabled={!!busy}
                                onClick={() => run(`done:${c.id}`, () => checkAction(machine.id, c.id, 'DONE'))}
                                title={t('check.doneTitle')}
                              >
                                <CheckCircle2 size={13} />
                                <span>{busy === `done:${c.id}` ? '...' : t('check.done')}</span>
                              </button>
                              <button
                                className="btn-icon btn-icon-danger w-8 h-8"
                                title={t('check.reportTitle')}
                                aria-label={t('sheet.reportProblem')}
                                onClick={() => {
                                  setProblemFor(c.id);
                                  setProblemText('');
                                  setProblemStops(false);
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
                                title={t('check.edit')}
                                aria-label={t('check.edit')}
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
                                title={t('check.remove')}
                                aria-label={t('check.remove')}
                                onClick={() => {
                                  if (confirm(t('check.confirmRemove', { title: c.title, machine: machine.name }))) run(`del:${c.id}`, () => deleteCheck(machine.id, c.id));
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
              <div className="section-label">{t('add.title')}</div>
              <div className="flex flex-wrap gap-2">
                <input
                  className="aurora-input flex-1 min-w-[200px] text-xs"
                  placeholder={t('add.placeholder')}
                  value={newTitle}
                  maxLength={160}
                  onChange={(e) => setNewTitle(e.target.value)}
                />
                <select className="aurora-input text-xs" aria-label={t('common:a11y.frequency')} value={newFreq} onChange={(e) => setNewFreq(e.target.value as Frequency)}>
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
                  <span>{t('common:actions.add')}</span>
                </button>
              </div>
            </section>
          )}

          <section className="space-y-2">
            <div className="section-label flex items-center gap-1.5">
              <HistoryIcon size={12} /> {t('history.title')}
            </div>
            {events.length === 0 ? (
              <div className="text-xs text-[var(--text-tertiary)]">{t('history.empty')}</div>
            ) : (
              <div className="space-y-1">
                {events.slice(0, 15).map((e, i) => {
                  const ok = saidOk(e, i);
                  return (
                  <div key={e.id} className={`flex items-start gap-2 text-xs ${ok || e.action === 'MISSED' ? 'history-clash' : ''}`}>
                    <span
                      className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${
                        e.action === 'PROBLEM' ? 'bg-[var(--rose-500)]' : e.action === 'DONE' || e.action === 'RESOLVE' ? 'bg-[var(--green-500)]' : 'bg-[var(--text-tertiary)]'
                      }`}
                    />
                    <span className="text-[var(--text-secondary)] flex-1">
                      <b className="text-[var(--text-primary)]">{e.username}</b> {t(actionKey(e.action), { users: e.note })}
                      {e.check_title && e.action !== 'PROBLEM' ? ` "${e.check_title}"` : ''}
                      {e.note && e.action !== 'MISSED' ? `: ${e.note}` : ''}
                      {ok && (
                        <span className="history-clash-note">
                          <AlertTriangle size={11} /> {t('history.saidOk', { user: ok })}
                        </span>
                      )}
                    </span>
                    <span className="text-[var(--text-tertiary)] shrink-0">{timeAgo(e.at, now)}</span>
                  </div>
                  );
                })}
              </div>
            )}
          </section>

          <div className="text-xs text-[var(--text-tertiary)] flex items-center gap-1.5">
            <Wrench size={12} /> {t('sheet.footer')}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
