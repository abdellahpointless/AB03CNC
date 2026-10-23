import React, { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { WifiOff, X } from 'lucide-react';
import { machineSubtitle, type FleetMachine, type MachineCheck, type machineSummary } from '../lib/fleet';
import { currentRegion } from '../lib/instance';
import { Flag } from './Flag';
import { useT } from '../i18n';
import { fmtDuration, fmtTime } from '../i18n/format';

type Summary = ReturnType<typeof machineSummary>;

/*
 * The status board for a TV: every machine of the country, full screen, readable from across the
 * room by anyone (managers, warehouse, design, production elsewhere), CNC knowledge not needed.
 * Calm when all is well: dark neutral tiles, colour only where something needs a look.
 *   Running            a small green dot
 *   Needs attention    amber dot, still running, its problems listed under it in red
 *   Stopped            the tile turns a deep red that slowly breathes, with how long it has been stopped
 * Everything fits on the screen without scrolling; tiles grow or shrink with the number of machines.
 */

/** Columns that give the biggest tiles for n machines in a w × h area. */
function bestColumns(n: number, w: number, h: number): number {
  let best = 1;
  let bestSize = 0;
  for (let cols = 1; cols <= Math.max(1, n); cols++) {
    const rows = Math.ceil(n / cols);
    // A tile is about as wide as it is tall (photo on top, words below).
    const size = Math.min(w / cols, (h / rows) * 1.05);
    if (size > bestSize + 0.5) {
      bestSize = size;
      best = cols;
    }
  }
  return best;
}

const problemText = (p: MachineCheck) => (p.kind === 'ISSUE' ? p.note || p.title : p.note ? `${p.title} — ${p.note}` : p.title);

export default function StatusBoard({
  fleet,
  summaries,
  now,
  offline,
  updatedAt,
  onClose,
}: {
  fleet: FleetMachine[];
  summaries: Map<string, Summary>;
  now: number;
  offline: boolean;
  updatedAt: number | null;
  onClose: () => void;
}) {
  const { t } = useT('preventive');
  const region = currentRegion();
  const gridRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ w: 1600, h: 800 });
  const [clock, setClock] = useState(Date.now());
  const [chrome, setChrome] = useState(true);

  // The clock and the "stopped for" times move on their own.
  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  // Size of the tile area (the TV, a window being resized).
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setArea({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Esc, or leaving full screen, closes the board. The exit button shows when the mouse moves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onFs = () => !document.fullscreenElement && onClose();
    let hide = setTimeout(() => setChrome(false), 3000);
    const onMove = () => {
      setChrome(true);
      clearTimeout(hide);
      hide = setTimeout(() => setChrome(false), 3000);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFs);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchstart', onMove);
    return () => {
      clearTimeout(hide);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFs);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('touchstart', onMove);
    };
  }, [onClose]);

  // A TV must not go to sleep while it shows the board.
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    let gone = false;
    const take = async () => {
      try {
        const wl = (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock;
        if (wl && document.visibilityState === 'visible') {
          lock = await wl.request('screen');
          if (gone) lock.release().catch(() => undefined);
        }
      } catch {
        /* not allowed: the TV's own settings decide */
      }
    };
    take();
    const onVis = () => document.visibilityState === 'visible' && take();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      gone = true;
      document.removeEventListener('visibilitychange', onVis);
      lock?.release().catch(() => undefined);
    };
  }, []);

  const tiles = useMemo(
    () =>
      fleet.map((m) => {
        const s = summaries.get(m.id);
        const state: 'down' | 'attention' | 'running' = !s ? 'running' : s.down ? 'down' : s.problems.length ? 'attention' : 'running';
        // Problems that stop the machine first.
        const problems = s ? [...s.problems].sort((a, b) => (b.stops ?? 0) - (a.stops ?? 0)) : [];
        return { m, state, problems, downSince: s?.downSince ?? null };
      }),
    [fleet, summaries],
  );
  const counts = useMemo(() => {
    const c = { running: 0, attention: 0, down: 0 };
    for (const x of tiles) c[x.state === 'down' ? 'down' : x.state === 'attention' ? 'attention' : 'running']++;
    return c;
  }, [tiles]);

  const cols = bestColumns(tiles.length, area.w, area.h);
  const rows = Math.max(1, Math.ceil(tiles.length / cols));
  // One "unit" = 1 % of a tile's smaller side: every size on a tile follows it.
  const unit = Math.max(2, Math.min(area.w / cols, area.h / rows) / 100);

  const downFor = (since: number | null) => {
    if (!since) return '';
    const sec = Math.max(60, (Math.max(clock, now) - since) / 1000);
    const days = Math.floor(sec / 86_400);
    return days >= 1 ? `${t('board.days', { count: days })} ${fmtDuration(sec - days * 86_400)}` : fmtDuration(sec);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      className="status-board"
      role="dialog"
      aria-modal="true"
      aria-label={t('board.title')}
    >
      <header className="sb-head">
        <div className="sb-title">
          {region && <Flag country={region.id} className="sb-flag" />}
          <span>{t('board.title')}</span>
        </div>
        <div className="sb-counts" aria-live="polite">
          {counts.down === 0 && counts.attention === 0 ? (
            <span className="sb-count running">
              <i className="sb-dot" /> {t('board.allRunning')}
            </span>
          ) : (
            <>
              {counts.down > 0 && (
                <span className="sb-count down">
                  <i className="sb-dot" /> {t('board.countStopped', { count: counts.down })}
                </span>
              )}
              {counts.attention > 0 && (
                <span className="sb-count attention">
                  <i className="sb-dot" /> {t('board.countAttention', { count: counts.attention })}
                </span>
              )}
              <span className="sb-count running">
                <i className="sb-dot" /> {t('board.countRunning', { count: counts.running })}
              </span>
            </>
          )}
        </div>
        <div className="sb-clock">
          <span className="sb-time">{fmtTime(clock)}</span>
          <span className="sb-date">{new Date(clock).toLocaleDateString(region.locale, { weekday: 'long', day: 'numeric', month: 'long' })}</span>
        </div>
      </header>

      <div ref={gridRef} className="sb-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`, '--u': `${unit}px` } as React.CSSProperties}>
        {tiles.map(({ m, state, problems, downSince }, i) => {
          const shown = problems.slice(0, state === 'down' ? 2 : 3);
          return (
            <motion.div
              key={m.id}
              initial={{ opacity: 0, y: 14, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ type: 'spring', duration: 0.6, bounce: 0.18, delay: Math.min(i * 0.04, 0.4) }}
              className={`sb-tile ${state}`}
              style={{ '--accent': m.accent } as React.CSSProperties}
            >
              <div className="sb-photo">
                <img src={m.image} alt="" draggable={false} />
              </div>
              <div className="sb-name">{m.name}</div>
              <div className="sb-sub">{machineSubtitle(m)}</div>
              <div className={`sb-state ${state}`}>
                <i className="sb-dot" />
                <span>
                  {state === 'down'
                    ? downSince
                      ? t('board.stoppedFor', { time: downFor(downSince) })
                      : t('board.stopped')
                    : state === 'attention'
                      ? t('board.attention')
                      : t('board.running')}
                </span>
              </div>
              {state === 'attention' && <div className="sb-since">{t('board.stillRunning')}</div>}
              {shown.length > 0 && (
                <ul className="sb-problems">
                  {shown.map((p) => (
                    <li key={p.id} className={p.stops ? 'stops' : ''}>
                      <span>{problemText(p)}</span>
                    </li>
                  ))}
                  {problems.length > shown.length && <li className="more">{t('board.more', { count: problems.length - shown.length })}</li>}
                </ul>
              )}
            </motion.div>
          );
        })}
      </div>

      <footer className={`sb-foot ${chrome ? 'show' : ''}`}>
        {offline ? (
          <span className="sb-offline">
            <WifiOff size={14} /> {t('board.offline')}
          </span>
        ) : (
          <span>{updatedAt ? t('board.updated', { time: fmtTime(updatedAt) }) : ''}</span>
        )}
        <span className="sb-foot-right">
          <span className="sb-hint">{t('board.exitHint')}</span>
          <button className={`sb-exit no-glass ${chrome ? 'show' : ''}`} onClick={onClose} aria-label={t('board.exit')}>
            <X size={16} />
            <span>{t('board.exit')}</span>
          </button>
        </span>
      </footer>
    </motion.div>
  );
}
