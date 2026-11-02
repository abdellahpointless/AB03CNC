import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { ArrowDownToLine, Pause, Play, Route, SkipBack, SkipForward, Timer, Wrench, X, Maximize2, ShieldCheck, ShieldAlert, Box, RotateCw, Layers, Info, Flame } from 'lucide-react';
import { parseToolpath, speedsFor, type Move, type Vec } from '../lib/toolpath';
import { toolAt } from '../lib/playback';
import { analyseProgram, calesKey, DEFAULT_JAW_HEIGHT, spacerAt, turnMs, type SetupInfo } from '../lib/setups';
import { WEAK_COLORS, WEAK_MM, type SolidState } from './Toolpath3D';
import { iosBackdrop, iosSurface } from '../lib/motion';
import { useT } from '../i18n';
import { fmtDuration, fmtNumber } from '../i18n/format';

const Toolpath3D = lazy(() => import('./Toolpath3D'));
// v2: the shop's jaws are 45 mm (the first default, 42, was a guess).
const JAW_KEY = 'cnc-toolpath-jaw-height-v2';
function readJaw(): number {
  try {
    const v = Number(localStorage.getItem(JAW_KEY));
    return v > 0 && v < 400 ? v : DEFAULT_JAW_HEIGHT;
  } catch {
    return DEFAULT_JAW_HEIGHT;
  }
}
const mm = (v: number) => fmtNumber(Math.round(v * 10) / 10, 1);

const COLORS = ['#5B8CF5', '#F0954F', '#3FB97A', '#C77DFF', '#F2C94C', '#4FD1C5', '#F472B6', '#A3E635'];
const SPEEDS = [10, 50, 250];
/** The viewer is always dark (like CAM software), also when the app is in light mode. */
const DARK_VARS = {
  '--text-primary': '#EEF1F6',
  '--text-secondary': '#A9B4C7',
  '--text-tertiary': '#7F8BA0',
  '--border-subtle': 'rgba(255,255,255,0.08)',
  '--border-strong': 'rgba(255,255,255,0.18)',
  '--bg-input': '#0A0F19',
  '--ov': '255,255,255',
} as React.CSSProperties;

type View = { x: number; y: number; w: number; h: number };

/** SVG path of a move in a 2D projection. */
function pathOf(mv: Move, project: (p: Vec) => [number, number]): string {
  return mv.points.map((p, i) => {
    const [a, b] = project(p);
    return `${i ? 'L' : 'M'}${a.toFixed(3)} ${b.toFixed(3)}`;
  }).join('');
}

function fitView(minA: number, maxA: number, minB: number, maxB: number): View {
  const w = Math.max(maxA - minA, 1);
  const h = Math.max(maxB - minB, 1);
  const pad = Math.max(w, h) * 0.08 + 2;
  return { x: minA - pad, y: minB - pad, w: w + pad * 2, h: h + pad * 2 };
}

const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

/** Full-screen toolpath preview: top and side views, one colour per tool, play through the program. */
export default function ToolpathViewer({ code, title, brand, onClose }: { code: string; title: string; brand?: string; onClose: () => void }) {
  const { t } = useT('remapper');
  const path = useMemo(() => parseToolpath(code, speedsFor(brand)), [code, brand]);
  const lines = useMemo(() => code.split('\n'), [code]);
  const total = path.moves.length;
  // Open at the start of the program: the raw part, before the first move.
  // clock: the instant shown (moves done + share of the current move), read by the 3D view on every
  // frame; step: the move shown in the panels (the one in progress), updated a few times a second.
  const clock = useRef(0);
  const [step, setStep] = useState(0);
  const [, setFrame] = useState(0);
  const seek = (n: number) => {
    clock.current = n;
    setStep(n);
  };
  const [jawHeight, setJawHeight] = useState(readJaw);
  const program = useMemo(() => analyseProgram(path, { jawHeight: DEFAULT_JAW_HEIGHT }), [path]);
  // The jaw height only changes the jaw check, not where the part is: keep the program (and the
  // cut part) when it changes.
  const setups = useMemo(() => (jawHeight === DEFAULT_JAW_HEIGHT ? program.setups : analyseProgram(path, { jawHeight }).setups), [program, path, jawHeight]);
  const [solid, setSolid] = useState<SolidState>({ state: 'off', share: 0 });
  /** While the part turns between setups, the new setup is shown before its first move. */
  const [turning, setTurning] = useState<number | null>(null);
  const multi = setups.length > 1;
  const [mode3d, setMode3d] = useState(true);
  const mode3dRef = useRef(mode3d);
  mode3dRef.current = mode3d;
  const [fitKey, setFitKey] = useState(0);
  const [isolate, setIsolate] = useState(false);
  // Weak spots: the finished part coloured by wall thickness.
  const [heat, setHeat] = useState(false);
  // The setup shown is the one of the current move, so playing goes through the setups.
  const currentMove = step > 0 ? path.moves[Math.min(step, total) - 1] : null;
  const sel: SetupInfo | null = setups[turning ?? currentMove?.setup ?? 0] ?? null;
  const range: [number, number] = sel?.moves ?? [0, Math.max(0, total - 1)];
  const totalHits = setups.reduce((n, x) => n + x.collisions.length, 0);
  useEffect(() => {
    try {
      localStorage.setItem(JAW_KEY, String(jawHeight));
    } catch {
      /* private mode */
    }
  }, [jawHeight]);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const colorOf = useMemo(() => {
    const map = new Map<number | null, string>();
    path.tools.forEach((tl, i) => map.set(tl.tool, COLORS[i % COLORS.length]));
    return (tool: number | null) => map.get(tool) ?? '#9AA6BA';
  }, [path]);

  // Time at the end of each move, for playing at a multiple of the real speed.
  const timeline = useMemo(() => {
    let s = 0;
    return path.moves.map((m) => (s += m.seconds));
  }, [path]);
  const at = clock.current;
  const atMove = Math.min(Math.floor(at), total - 1);
  const elapsed = total ? (atMove > 0 ? timeline[atMove - 1] : 0) + Math.min(1, at - atMove) * path.moves[atMove].seconds : 0;

  // First move of each setup after the first: playback stops there while the part turns.
  const setupStarts = useMemo(() => setups.slice(1).map((x) => x.moves?.[0] ?? -1).filter((x) => x > 0), [setups]);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const from = clock.current >= total ? 0 : clock.current;
    let k = Math.floor(from);
    let sim = (k > 0 ? timeline[k - 1] : 0) + (from - k) * (path.moves[k]?.seconds ?? 0);
    let shownAt = 0;
    let holdUntil = 0;
    /** First move of the setup the part just turned for (shown as that setup until it starts). */
    let held = -1;
    if (clock.current >= total) seek(0);
    const tick = (now: number) => {
      if (now < holdUntil) {
        last = now;
        raf = requestAnimationFrame(tick);
        return;
      }
      if (holdUntil) holdUntil = 0;
      sim += ((now - last) / 1000) * SPEEDS[speed];
      last = now;
      const before = k;
      while (k < total && timeline[k] <= sim) k++;
      // Reaching a new setup: stop before its first move, let the part turn, then go on.
      const start = setupStarts.find((x) => x >= before && x < k && x !== held);
      if (start !== undefined) {
        held = start;
        k = start;
        sim = timeline[start - 1];
        // The 3D view turns the part (and changes the cales); the 2D view just marks the new setup.
        const next = path.moves[start].setup;
        holdUntil = now + (mode3dRef.current ? turnMs(setups[next - 1] ?? null, setups[next] ?? null) + 150 : 600);
        setTurning(path.moves[start].setup);
        seek(k);
        raf = requestAnimationFrame(tick);
        return;
      }
      // The tool glides: the share of the move in progress, on every frame.
      const pos = k >= total ? total : k + Math.min(1, Math.max(0, (sim - (k > 0 ? timeline[k - 1] : 0)) / (path.moves[k].seconds || 1)));
      clock.current = pos;
      // The panels (current line, time) at ~15 updates a second: they do not need more.
      if (now - shownAt > 66 || k >= total) {
        shownAt = now;
        setStep(Math.min(total, Math.max(1, Math.ceil(pos))));
        setFrame((f) => f + 1);
        if (held >= 0 && k > held) setTurning(null);
      }
      if (k >= total) setPlaying(false);
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      setTurning(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === ' ') {
        e.preventDefault();
        setPlaying((p) => !p);
      }
      if (e.key === 'ArrowRight') seek(Math.min(total, Math.floor(clock.current) + 1));
      if (e.key === 'ArrowLeft') seek(Math.max(0, Math.ceil(clock.current) - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, total]);

  const top = (p: Vec): [number, number] => [p[0], -p[1]];
  const side = (p: Vec): [number, number] => [p[0], -p[2]];
  const topPaths = useMemo(() => path.moves.map((m) => (m.kind === 'drill' ? '' : pathOf(m, top))), [path]);
  const sidePaths = useMemo(
    () => path.moves.map((m) => (m.kind === 'drill' ? pathOf({ ...m, points: [m.points[0], [m.points[0][0], m.points[0][1], m.depth ?? m.points[0][2]]] }, side) : pathOf(m, side))),
    [path],
  );

  // Extent of the setup shown: its moves, the part and the jaws.
  const bounds = useMemo(() => {
    const lo: Vec = [Infinity, Infinity, Infinity];
    const hi: Vec = [-Infinity, -Infinity, -Infinity];
    const add = (p: Vec) => p.forEach((x, i) => { lo[i] = Math.min(lo[i], x); hi[i] = Math.max(hi[i], x); });
    for (let i = range[0]; i <= range[1] && i < total; i++) {
      const m = path.moves[i];
      m.points.forEach(add);
      if (m.kind === 'drill' && m.depth !== undefined) add([m.points[0][0], m.points[0][1], m.depth]);
    }
    if (sel?.stock) {
      add(sel.stock.min);
      add(sel.stock.max);
      if (sel.floorZ !== null) add([sel.stock.min[0], sel.stock.min[1], sel.floorZ]);
    }
    if (!Number.isFinite(lo[0])) return { min: path.min, max: path.max };
    return { min: lo, max: hi };
  }, [path, range[0], range[1], sel, total]);
  const homeTop = useMemo(() => fitView(bounds.min[0], bounds.max[0], -bounds.max[1], -bounds.min[1]), [bounds]);
  const homeSide = useMemo(() => fitView(bounds.min[0], bounds.max[0], -bounds.max[2], -bounds.min[2]), [bounds]);
  const [view, setView] = useState<View>(homeTop);
  useEffect(() => setView(homeTop), [homeTop]);

  // Zoom with the wheel around the pointer, pan by dragging, double-click to fit.
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; v: View } | null>(null);
  const toWorld = (clientX: number, clientY: number, v: View) => {
    const r = svgRef.current!.getBoundingClientRect();
    const scale = Math.max(v.w / r.width, v.h / r.height);
    const ox = v.x + (v.w - r.width * scale) / 2;
    const oy = v.y + (v.h - r.height * scale) / 2;
    return { x: ox + (clientX - r.left) * scale, y: oy + (clientY - r.top) * scale, scale };
  };
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setView((v) => {
        const p = toWorld(e.clientX, e.clientY, v);
        const f = Math.exp(e.deltaY * 0.0015);
        return { x: p.x - (p.x - v.x) * f, y: p.y - (p.y - v.y) * f, w: v.w * f, h: v.h * f };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Done part grouped by tool and kind, so a long program stays a handful of SVG paths.
  const done = useMemo(() => {
    const feeds = new Map<number | null, string[]>();
    const rapids: string[] = [];
    const sideFeeds = new Map<number | null, string[]>();
    const sideRapids: string[] = [];
    const holes: Move[] = [];
    if (mode3d) return { feeds, rapids, sideFeeds, sideRapids, holes };
    for (let i = range[0]; i < Math.min(step, range[1] + 1); i++) {
      const m = path.moves[i];
      if (m.kind === 'drill') {
        holes.push(m);
        if (!sideFeeds.has(m.tool)) sideFeeds.set(m.tool, []);
        sideFeeds.get(m.tool)!.push(sidePaths[i]);
      } else if (m.kind === 'rapid') {
        rapids.push(topPaths[i]);
        sideRapids.push(sidePaths[i]);
      } else {
        if (!feeds.has(m.tool)) feeds.set(m.tool, []);
        feeds.get(m.tool)!.push(topPaths[i]);
        if (!sideFeeds.has(m.tool)) sideFeeds.set(m.tool, []);
        sideFeeds.get(m.tool)!.push(sidePaths[i]);
      }
    }
    return { feeds, rapids, sideFeeds, sideRapids, holes };
  }, [step, path, topPaths, sidePaths, range[0], range[1], mode3d]);
  const ghost = useMemo(() => topPaths.slice(range[0], range[1] + 1).join(''), [topPaths, range[0], range[1]]);
  const sideGhost = useMemo(() => sidePaths.slice(range[0], range[1] + 1).join(''), [sidePaths, range[0], range[1]]);
  const goSetup = (s: SetupInfo) => {
    if (!s.moves) return;
    setPlaying(false);
    seek(s.moves[1] + 1);
  };
  // Instructions in the user's language (the original text is shown under them).
  const instructions = (s: SetupInfo): string[] => {
    const out: string[] = [];
    for (const r of s.turns) out.push(t('toolpath.ins.rotation', { deg: Math.abs(r.deg), axis: r.axis }));
    if (s.side) out.push(t(`toolpath.ins.${s.side}`));
    if (s.onEdge) out.push(t('toolpath.ins.onEdge'));
    if (s.sizes) out.push(Number.isFinite(s.sizes.y) ? t('toolpath.ins.sizes', { x: fmtNumber(s.sizes.x), y: fmtNumber(s.sizes.y) }) : t('toolpath.ins.sizeX', { x: fmtNumber(s.sizes.x) }));
    if (s.topToward) out.push(t('toolpath.ins.topToward', { face: s.topToward }));
    if (s.support !== null) out.push(t('toolpath.ins.support', { mm: fmtNumber(s.support) }));
    if (s.restDepth !== null) out.push(t('toolpath.ins.restDepth', { mm: fmtNumber(s.restDepth) }));
    if (s.spacer) out.push(t('toolpath.ins.spacer', { mm: fmtNumber(s.spacer.mm), side: s.spacer.side }));
    if (s.topAt !== null) out.push(t('toolpath.ins.topAt', { mm: fmtNumber(s.topAt) }));
    if (s.marker) out.push(t('toolpath.ins.marker', { name: s.marker.name, faces: s.marker.faces.join(' ') }));
    return out;
  };

  const current = step > 0 ? path.moves[step - 1] : null;
  const here = current ? toolAt(path.moves, clock.current)?.p ?? null : null;
  const curLine = current ? lines[current.line] : '';
  const holeR = Math.max(homeTop.w, homeTop.h) * 0.008;
  const firstHoleTool = useMemo(() => {
    const drilling = path.moves.find((m) => m.kind === 'drill');
    return drilling ? Math.max(0, path.tools.findIndex((tl) => tl.tool === drilling.tool)) : 0;
  }, [path]);

  return createPortal(
    <motion.div className="fixed inset-0 modal-backdrop flex items-center justify-center p-3 sm:p-6 z-[99999]" onMouseDown={(e) => e.target === e.currentTarget && onClose()} {...iosBackdrop}>
      <motion.div className="w-full max-w-7xl h-[92vh] flex flex-col overflow-hidden rounded-[var(--radius-lg,20px)] border border-[var(--border-subtle)] bg-[#0E1421] text-[var(--text-primary)] shadow-[0_30px_90px_rgba(0,0,0,0.6)]" style={DARK_VARS} {...iosSurface} role="dialog" aria-label={t('toolpath.title')}>
        {/* Header: title and the program's key figures as symbols */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-[var(--border-subtle)] flex-wrap">
          <Route size={18} className="text-[var(--accent-primary)]" />
          <h3 className="font-bold text-[var(--text-primary)]">{t('toolpath.title')}</h3>
          <span className="font-mono text-xs text-[var(--text-tertiary)] truncate max-w-[30ch]">{title}</span>
          <div className="flex items-center gap-2 ml-auto flex-wrap">
            <span className="badge-neutral text-xs py-1 px-2.5 inline-flex items-center gap-1.5" title={t('toolpath.estimateNote')}>
              <Timer size={13} /> ≈ {fmtDuration(path.totalSeconds)}
            </span>
            <span className="badge-neutral text-xs py-1 px-2.5 inline-flex items-center gap-1.5" title={t('toolpath.tools')}>
              <Wrench size={13} /> {path.tools.length}
            </span>
            {path.lowestZ !== null && (
              <span className="badge-neutral text-xs py-1 px-2.5 inline-flex items-center gap-1.5 font-mono" title={t('toolpath.lowestZ')}>
                <ArrowDownToLine size={13} /> Z{fmtNumber(path.lowestZ, 2)}
              </span>
            )}
            {setups.some((x) => x.jawTopZ !== null) && (
              <span className={`${totalHits ? 'badge-danger' : 'badge-positive'} text-xs py-1 px-2.5 inline-flex items-center gap-1.5`}>
                {totalHits ? <ShieldAlert size={13} /> : <ShieldCheck size={13} />}
                {totalHits ? t('toolpath.jawHits', { count: totalHits }) : t('toolpath.jawClear')}
              </span>
            )}
            <button onClick={onClose} className="btn-icon w-8 h-8" title={t('common:actions.close')} aria-label={t('common:actions.close')}>
              <X size={15} />
            </button>
          </div>
        </div>

        {multi && (
          <div className="flex items-center gap-2 px-5 py-2 border-b border-[var(--border-subtle)] overflow-x-auto" role="tablist" aria-label={t('toolpath.setup', { n: '' })}>
            <Layers size={14} className="text-[var(--text-tertiary)] shrink-0" />
            {setups.map((s) => {
              const active = sel?.index === s.index;
              return (
                <button
                  key={s.index}
                  role="tab"
                  aria-selected={active}
                  disabled={!s.moves}
                  onClick={() => goSetup(s)}
                  className={`shrink-0 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition-colors disabled:opacity-40 ${active ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/15 text-[var(--text-primary)]' : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[rgba(var(--ov),0.05)]'}`}
                >
                  <span className={`w-5 h-5 rounded-full grid place-items-center font-mono font-bold text-[11px] ${active ? 'bg-[var(--accent-primary)] text-white' : 'bg-[rgba(var(--ov),0.08)]'}`}>{s.index + 1}</span>
                  {s.clamp && <span>{t(`toolpath.clamp.${s.clamp}`)}</span>}
                  {s.rotation && (
                    <span className="inline-flex items-center gap-0.5 font-mono text-[11px] text-[var(--text-tertiary)]">
                      <RotateCw size={11} />
                      {s.rotation.deg}° {s.rotation.axis}
                    </span>
                  )}
                  {s.support !== null && <span className="font-mono text-[11px] text-[var(--text-tertiary)]">▭{fmtNumber(s.support)}</span>}
                  {s.marker && <span className="font-mono text-[10px] font-bold text-[#FFB869]">{s.marker.name}</span>}
                  {s.jawTopZ !== null && (s.collisions.length ? <span className="badge-danger text-[10px] px-1.5 py-0 font-bold">{s.collisions.length}</span> : <ShieldCheck size={12} className="text-[var(--emerald-500,#3FB97A)]" />)}
                </button>
              );
            })}
          </div>
        )}

        {total === 0 ? (
          <div className="flex-1 flex items-center justify-center text-sm text-[var(--text-secondary)]">{t('toolpath.noMoves')}</div>
        ) : (
          <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_300px]">
            <div className="min-h-0 flex flex-col">
              {/* Top view */}
              <div className="relative flex-1 min-h-0 bg-[#0A0F19]">
                {mode3d && (
                  <Suspense fallback={null}>
                    <Toolpath3D path={path} program={program} setup={sel} range={range} clock={clock} colorOf={colorOf} fitKey={fitKey} onSolid={setSolid} isolate={isolate} heat={heat} />
                  </Suspense>
                )}
                {!mode3d && <span className="absolute left-3 top-2 text-[11px] font-mono text-[#7F8BA0] pointer-events-none">XY ↑</span>}
                {/* The cales (parallels) the part stands on; while the part turns, the change. */}
                {mode3d && heat && (
                  <div className="absolute right-3 bottom-3 z-10 w-64 rounded-[var(--radius-md,12px)] border border-[var(--border-subtle)] bg-[#0E1421]/90 px-3 py-2 space-y-1.5" role="note">
                    <div className="text-[11px] font-semibold text-[var(--text-primary)]">{t('toolpath.heatTitle')}</div>
                    {/* The scale from 0 to 3 mm, each colour where its thickness is. */}
                    <div
                      className="h-2 rounded-full"
                      style={{ background: `linear-gradient(90deg, ${WEAK_COLORS[0]} 0%, ${WEAK_MM.map((mm, i) => `${WEAK_COLORS[i]} ${(mm / WEAK_MM[3]) * 100}%`).join(', ')})` }}
                      aria-hidden="true"
                    />
                    <div className="relative h-3 text-[10px] font-mono text-[var(--text-secondary)]">
                      {WEAK_MM.map((mm, i) => (
                        <span key={mm} className="absolute -translate-x-1/2 first:translate-x-0 last:-translate-x-full whitespace-nowrap" style={{ left: `${(mm / WEAK_MM[3]) * 100}%` }}>
                          {i === 0 ? '≤' : i === WEAK_MM.length - 1 ? '≥' : ''}
                          {fmtNumber(mm)}
                        </span>
                      ))}
                    </div>
                    <p className="text-[10px] leading-snug text-[var(--text-tertiary)]">{t('toolpath.heatNote')}</p>
                  </div>
                )}
                {mode3d && !isolate && sel?.cales?.length && sel.support !== null ? (() => {
                  const before = turning !== null ? setups[turning - 1] : null;
                  const change = before && calesKey(before) !== calesKey(sel) && before.support !== null && before.support !== sel.support;
                  return (
                    <div
                      className={`absolute left-3 bottom-3 z-10 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold transition-colors ${change ? 'border-[#FFD27A] bg-[#2A2210]/90 text-[#FFD27A]' : 'border-[var(--border-subtle)] bg-[#0E1421]/85 text-[var(--text-secondary)]'}`}
                      title={t('toolpath.calesHelp')}
                    >
                      <span className="font-mono text-[13px] leading-none">▭</span>
                      {change ? t('toolpath.calesChange', { from: fmtNumber(before!.support!), to: fmtNumber(sel.support) }) : t('toolpath.cales', { mm: fmtNumber(sel.support) })}
                    </div>
                  );
                })() : null}
                {mode3d && solid.state === 'carving' && (
                  <div className="absolute left-3 top-2 z-10 inline-flex items-center gap-2 rounded-full bg-[#0E1421]/85 border border-[var(--border-subtle)] px-3 py-1 text-[11px] text-[var(--text-secondary)]">
                    <span className="w-16 h-1 rounded-full bg-[rgba(var(--ov),0.1)] overflow-hidden"><span className="block h-full bg-[var(--accent-primary)]" style={{ width: `${Math.round(solid.share * 100)}%` }} /></span>
                    {t('toolpath.carving')}
                  </div>
                )}
                <div className="absolute right-3 top-2 z-10 flex items-center gap-2">
                  <div className="inline-flex rounded-full border border-[var(--border-subtle)] bg-[#0E1421]/80 p-0.5" role="radiogroup" aria-label="3D / 2D">
                    {[true, false].map((m) => (
                      <button key={String(m)} role="radio" aria-checked={mode3d === m} onClick={() => setMode3d(m)} className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold ${mode3d === m ? 'bg-[var(--accent-primary)] text-white' : 'text-[var(--text-secondary)]'}`}>
                        {m ? t('toolpath.view3d') : t('toolpath.view2d')}
                      </button>
                    ))}
                  </div>
                  {mode3d && (
                    <button
                      onClick={() => setIsolate((x) => !x)}
                      aria-pressed={isolate}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 h-7 text-[11px] font-semibold ${isolate ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)] text-white' : 'border-[var(--border-subtle)] bg-[#0E1421]/80 text-[var(--text-secondary)]'}`}
                      title={t('toolpath.isolateHelp')}
                    >
                      <Box size={12} />
                      {t('toolpath.isolate')}
                    </button>
                  )}
                  {mode3d && (
                    <button
                      onClick={() => {
                        // The colours are the finished part's: show it.
                        if (!heat) seek(total);
                        setHeat((x) => !x);
                      }}
                      aria-pressed={heat}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 h-7 text-[11px] font-semibold ${heat ? 'border-[#ff9a2e] bg-[#ff9a2e] text-[#1a1206]' : 'border-[var(--border-subtle)] bg-[#0E1421]/80 text-[var(--text-secondary)]'}`}
                      title={t('toolpath.heatHelp')}
                    >
                      <Flame size={12} />
                      {t('toolpath.heat')}
                    </button>
                  )}
                  <button onClick={() => (mode3d ? setFitKey((k) => k + 1) : setView(homeTop))} className="btn-icon w-7 h-7" title={t('toolpath.fit')} aria-label={t('toolpath.fit')}>
                    <Maximize2 size={13} />
                  </button>
                </div>
                {!mode3d && <svg
                  ref={svgRef}
                  className="w-full h-full cursor-grab active:cursor-grabbing touch-none"
                  viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
                  preserveAspectRatio="xMidYMid meet"
                  onDoubleClick={() => setView(homeTop)}
                  onPointerDown={(e) => {
                    (e.target as Element).setPointerCapture?.(e.pointerId);
                    drag.current = { x: e.clientX, y: e.clientY, v: view };
                  }}
                  onPointerMove={(e) => {
                    const d = drag.current;
                    if (!d) return;
                    const { scale } = toWorld(e.clientX, e.clientY, d.v);
                    setView({ ...d.v, x: d.v.x - (e.clientX - d.x) * scale, y: d.v.y - (e.clientY - d.y) * scale });
                  }}
                  onPointerUp={() => (drag.current = null)}
                >
                  {sel?.stock && (
                    <g>
                      {sel.jawTopZ !== null &&
                        [[sel.stock.max[1] + spacerAt(sel, 'Y+'), sel.stock.max[1] + spacerAt(sel, 'Y+') + 24], [sel.stock.min[1] - spacerAt(sel, 'Y-') - 24, sel.stock.min[1] - spacerAt(sel, 'Y-')]].map(([a, b], i) => (
                          <rect key={i} x={sel.jawX[0]} y={-b} width={sel.jawX[1] - sel.jawX[0]} height={b - a} fill="#5A6A82" fillOpacity={0.35} stroke="#7F8BA0" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                        ))}
                      {sel.jawTopZ !== null && sel.spacer && (() => {
                        // The spacer plate between the part and the jaw or the stop.
                        const { mm, side } = sel.spacer;
                        const st = sel.stock;
                        const [x0, x1, y0, y1] =
                          side === 'Y-' ? [sel.jawX[0], sel.jawX[1], st.min[1] - mm, st.min[1]] : side === 'Y+' ? [sel.jawX[0], sel.jawX[1], st.max[1], st.max[1] + mm] : side === 'X-' ? [st.min[0] - mm, st.min[0], st.min[1], st.max[1]] : [0, 0, 0, 0];
                        return x1 > x0 && <rect x={x0} y={-y1} width={x1 - x0} height={y1 - y0} fill="#C9D3E0" fillOpacity={0.25} stroke="#C9D3E0" strokeOpacity={0.6} strokeDasharray="3 2" strokeWidth={1} vectorEffect="non-scaling-stroke" />;
                      })()}
                      <rect x={sel.stock.min[0]} y={-sel.stock.max[1]} width={sel.stock.max[0] - sel.stock.min[0]} height={sel.stock.max[1] - sel.stock.min[1]} fill="#B9C6DA" fillOpacity={0.08} stroke="#B9C6DA" strokeOpacity={0.6} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
                    </g>
                  )}
                  <path d={ghost} fill="none" stroke="#2A3650" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                  <path d={done.rapids.join('')} fill="none" stroke="#7F8BA0" strokeWidth={1} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" opacity={0.7} />
                  {[...done.feeds].map(([tool, parts]) => (
                    <path key={String(tool)} d={parts.join('')} fill="none" stroke={colorOf(tool)} strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                  ))}
                  {/* A hole drilled by several tools (spot, drill, tap) shows one ring per tool. */}
                  {done.holes.map((h, i) => {
                    const ring = 1.1 + 0.75 * Math.max(0, path.tools.findIndex((tl) => tl.tool === h.tool) - firstHoleTool);
                    return (
                      <g key={i}>
                        <circle cx={h.points[0][0]} cy={-h.points[0][1]} r={holeR * ring} fill="none" stroke={colorOf(h.tool)} strokeWidth={2.2} vectorEffect="non-scaling-stroke" />
                        <circle cx={h.points[0][0]} cy={-h.points[0][1]} r={holeR * 0.4} fill={colorOf(h.tool)} />
                      </g>
                    );
                  })}
                  {sel?.collisions.map((c, i) => (
                    <circle key={`hit${i}`} cx={c.point[0]} cy={-c.point[1]} r={holeR * 1.6} fill="#FF4D4D" fillOpacity={0.85} />
                  ))}
                  {here && (
                    <g>
                      <circle cx={here[0]} cy={-here[1]} r={holeR * 2.6} fill="#F3F6FC" fillOpacity={0.15} />
                      <circle cx={here[0]} cy={-here[1]} r={holeR * 1.1} fill="#F3F6FC" stroke={colorOf(current!.tool)} strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
                    </g>
                  )}
                </svg>}
              </div>
              {/* Side view (2D only: the 3D view shows the heights) */}
              {!mode3d && <div className="relative h-32 shrink-0 border-t border-[var(--border-subtle)] bg-[#0A0F19]">
                <span className="absolute left-3 top-2 text-[11px] font-mono text-[#7F8BA0] pointer-events-none">XZ ↕</span>
                <svg className="w-full h-full" viewBox={`${homeSide.x} ${homeSide.y} ${homeSide.w} ${homeSide.h}`} preserveAspectRatio="none">
                  <line x1={homeSide.x} x2={homeSide.x + homeSide.w} y1={0} y2={0} stroke="#3A4762" strokeWidth={1} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
                  {sel?.stock && <rect x={sel.stock.min[0]} y={-sel.stock.max[2]} width={sel.stock.max[0] - sel.stock.min[0]} height={sel.stock.max[2] - sel.stock.min[2]} fill="#B9C6DA" fillOpacity={0.08} stroke="#B9C6DA" strokeOpacity={0.5} strokeWidth={1} vectorEffect="non-scaling-stroke" />}
                  {sel?.jawTopZ != null && <line x1={homeSide.x} x2={homeSide.x + homeSide.w} y1={-sel.jawTopZ} y2={-sel.jawTopZ} stroke="#F26D6D" strokeOpacity={0.7} strokeWidth={1.2} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
                  {sel?.floorZ != null && <line x1={homeSide.x} x2={homeSide.x + homeSide.w} y1={-sel.floorZ} y2={-sel.floorZ} stroke="#5A6A82" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
                  <path d={sideGhost} fill="none" stroke="#2A3650" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                  <path d={done.sideRapids.join('')} fill="none" stroke="#7F8BA0" strokeWidth={1} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" opacity={0.7} />
                  {[...done.sideFeeds].map(([tool, parts]) => (
                    <path key={String(tool)} d={parts.join('')} fill="none" stroke={colorOf(tool)} strokeWidth={2} vectorEffect="non-scaling-stroke" />
                  ))}
                  {here && <line x1={here[0]} x2={here[0]} y1={-here[2]} y2={-here[2] - homeSide.h * 0.25} stroke="#F3F6FC" strokeWidth={3} strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
                </svg>
              </div>}
            </div>

            {/* Side panel: tools with their colour and time, the current line */}
            <div className="min-h-0 overflow-y-auto border-t lg:border-t-0 lg:border-l border-[var(--border-subtle)] p-4 space-y-4">
              {sel && sel.notes.length > 0 ? (
                <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[rgba(var(--ov),0.03)] p-3 space-y-2.5">
                  <div className="flex items-center gap-2">
                    <Box size={14} className="text-[var(--accent-primary)]" />
                    <span className="text-xs font-bold text-[var(--text-primary)]">{multi ? t('toolpath.setupOf', { n: sel.index + 1, total: setups.length }) : t('toolpath.setup', { n: 1 })}</span>
                    {sel.clamp && <span className="badge-neutral text-[10px] py-0.5 px-2 ml-auto">{t(`toolpath.clamp.${sel.clamp}`)}</span>}
                  </div>
                  <ul className="space-y-1">
                    {instructions(sel).map((x, i) => (
                      <li key={i} className="text-xs text-[var(--text-primary)] flex gap-2"><span className="text-[var(--accent-primary)]">•</span>{x}</li>
                    ))}
                  </ul>
                  {sel.stock && (
                    <div className="text-[11px] font-mono text-[var(--text-secondary)]">
                      {t('toolpath.part', { x: mm(sel.stock.max[0] - sel.stock.min[0]), y: mm(sel.stock.max[1] - sel.stock.min[1]), z: mm(sel.stock.max[2] - sel.stock.min[2]) })}
                    </div>
                  )}
                  <details className="text-[11px] text-[var(--text-tertiary)]">
                    <summary className="cursor-pointer select-none">{t('toolpath.original')}</summary>
                    <div className="font-mono mt-1 space-y-0.5 break-words">{sel.notes.map((n, i) => <div key={i}>({n})</div>)}</div>
                  </details>
                  {sel.jawTopZ !== null ? (
                    <div className="space-y-2 pt-1 border-t border-[var(--border-subtle)]">
                      {sel.collisions.length ? (
                        <div className="space-y-1">
                          <div className="badge-danger text-xs py-1 px-2.5 inline-flex items-center gap-1.5"><ShieldAlert size={13} />{t('toolpath.jawHits', { count: sel.collisions.length })}</div>
                          {sel.collisions.slice(0, 8).map((c, i) => (
                            <button key={i} type="button" onClick={() => { setPlaying(false); seek(c.move + 1); }} className="w-full text-left text-[11px] font-mono text-[#FF8A8A] hover:underline">
                              #{c.line + 1} · {t('toolpath.jawHit', { t: c.tool ?? '?', mm: mm(c.depth) })}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="badge-positive text-xs py-1 px-2.5 inline-flex items-center gap-1.5">
                          <ShieldCheck size={13} />
                          {sel.jawClearance !== null ? t('toolpath.jawClearBy', { mm: mm(sel.jawClearance) }) : t('toolpath.jawClear')}
                        </div>
                      )}
                      <label className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]" title={t('toolpath.jawHeightHelp')}>
                        <span>{t('toolpath.jawHeight')}</span>
                        <input
                          type="number"
                          min={5}
                          max={300}
                          step={0.5}
                          value={jawHeight}
                          onChange={(e) => { const v = Number(e.target.value); if (v > 0 && v < 400) setJawHeight(v); }}
                          className="aurora-input text-xs w-20 py-1 px-2 font-mono"
                        />
                        <span>mm</span>
                      </label>
                    </div>
                  ) : (
                    sel.clamp === 'fixture' && <div className="text-[11px] text-[var(--text-tertiary)]">{t('toolpath.noJawCheck')}</div>
                  )}
                  {sel.jawTopZ !== null && <p className="text-[10px] leading-relaxed text-[var(--text-tertiary)] flex gap-1.5"><Info size={11} className="shrink-0 mt-0.5" />{t('toolpath.setupNote')}</p>}
                </div>
              ) : (
                <p className="text-[11px] text-[var(--text-tertiary)] leading-relaxed">{t('toolpath.noSetup')}</p>
              )}
              <div className="space-y-1.5">
                {path.tools.map((tl) => {
                  const active = current?.tool === tl.tool;
                  return (
                    <button
                      key={tl.tool}
                      type="button"
                      onClick={() => {
                        setPlaying(false);
                        const k = path.moves.findIndex((m) => m.tool === tl.tool);
                        seek(k >= 0 ? k + 1 : step);
                      }}
                      className={`w-full flex items-center gap-2.5 text-left rounded-[var(--radius-sm)] px-2.5 py-2 border transition-colors ${active ? 'border-[var(--border-strong)] bg-[rgba(var(--ov),0.06)]' : 'border-transparent hover:bg-[rgba(var(--ov),0.04)]'}`}
                    >
                      <span className="w-3 h-3 rounded-full shrink-0" style={{ background: colorOf(tl.tool) }} />
                      <span className="font-mono text-xs font-bold text-[var(--text-primary)] shrink-0">T{tl.tool}</span>
                      <span className="text-xs text-[var(--text-secondary)] truncate flex-1">{tl.label}</span>
                      <span className="font-mono text-[11px] text-[var(--text-tertiary)] shrink-0">{fmtClock(tl.seconds)}</span>
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--text-tertiary)]">
                <span className="inline-flex items-center gap-1.5"><svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke="#7F8BA0" strokeDasharray="4 3" /></svg>G0</span>
                <span className="inline-flex items-center gap-1.5"><svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke="#5B8CF5" strokeWidth="2.5" /></svg>G1 G2 G3</span>
                <span className="inline-flex items-center gap-1.5"><svg width="12" height="12"><circle cx="6" cy="6" r="5" fill="#5B8CF5" fillOpacity=".3" stroke="#5B8CF5" /></svg>G81–G89</span>
              </div>
              {current && (
                <div className="rounded-[var(--radius-md)] bg-[var(--bg-input)] border border-[var(--border-subtle)] p-3 space-y-1">
                  <div className="text-[11px] text-[var(--text-tertiary)] font-mono"># {current.line + 1}</div>
                  <div className="font-mono text-xs text-[var(--text-primary)] break-all">{curLine.trim()}</div>
                  {here && (
                    <div className="font-mono text-[11px] text-[var(--text-secondary)] pt-1">
                      X{fmtNumber(here[0], 3)} Y{fmtNumber(here[1], 3)} Z{fmtNumber(here[2], 3)}
                    </div>
                  )}
                </div>
              )}
              <p className="text-[11px] text-[var(--text-tertiary)] leading-relaxed">{t('toolpath.estimateNote')}</p>
            </div>
          </div>
        )}

        {/* Player */}
        {total > 0 && (
          <div className="flex items-center gap-3 px-5 py-3 border-t border-[var(--border-subtle)]">
            <button onClick={() => seek(0)} className="btn-icon w-8 h-8" aria-label={t('toolpath.start')} title={t('toolpath.start')}>
              <SkipBack size={14} />
            </button>
            <button onClick={() => setPlaying((p) => !p)} className="btn-primary w-10 h-10 !p-0 rounded-full justify-center" aria-label={playing ? t('toolpath.pause') : t('toolpath.play')} title={playing ? t('toolpath.pause') : t('toolpath.play')}>
              {playing ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <button onClick={() => seek(total)} className="btn-icon w-8 h-8" aria-label={t('toolpath.end')} title={t('toolpath.end')}>
              <SkipForward size={14} />
            </button>
            <input
              type="range"
              min={0}
              max={total}
              value={step}
              onChange={(e) => {
                setPlaying(false);
                seek(Number(e.target.value));
              }}
              className="flex-1 accent-[var(--accent-primary)]"
              aria-label={t('toolpath.position')}
            />
            <span className="font-mono text-xs text-[var(--text-secondary)] w-28 text-right">
              {fmtClock(elapsed)} / {fmtClock(path.totalSeconds)}
            </span>
            <div className="inline-flex rounded-full border border-[var(--border-subtle)] p-0.5" role="radiogroup" aria-label={t('toolpath.speed')}>
              {SPEEDS.map((s, i) => (
                <button key={s} role="radio" aria-checked={speed === i} onClick={() => setSpeed(i)} className={`px-2 py-0.5 rounded-full text-[11px] font-mono font-bold ${speed === i ? 'bg-[var(--accent-primary)] text-white' : 'text-[var(--text-secondary)]'}`}>
                  {s}×
                </button>
              ))}
            </div>
          </div>
        )}
      </motion.div>
    </motion.div>,
    document.body,
  );
}
