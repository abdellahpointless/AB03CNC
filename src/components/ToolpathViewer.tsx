import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { ArrowDownToLine, Pause, Play, Route, SkipBack, SkipForward, Timer, Wrench, X, Maximize2 } from 'lucide-react';
import { parseToolpath, speedsFor, type Move, type Vec } from '../lib/toolpath';
import { iosBackdrop, iosSurface } from '../lib/motion';
import { useT } from '../i18n';
import { fmtDuration, fmtNumber } from '../i18n/format';

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
  const [step, setStep] = useState(total);
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
  const elapsed = step > 0 ? timeline[step - 1] : 0;

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let sim = step >= total ? 0 : elapsed;
    if (step >= total) setStep(0);
    const tick = (now: number) => {
      sim += ((now - last) / 1000) * SPEEDS[speed];
      last = now;
      let k = 0;
      while (k < total && timeline[k] <= sim) k++;
      setStep(Math.max(k, 1));
      if (k >= total) setPlaying(false);
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === ' ') {
        e.preventDefault();
        setPlaying((p) => !p);
      }
      if (e.key === 'ArrowRight') setStep((s) => Math.min(total, s + 1));
      if (e.key === 'ArrowLeft') setStep((s) => Math.max(0, s - 1));
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

  const homeTop = useMemo(() => fitView(path.min[0], path.max[0], -path.max[1], -path.min[1]), [path]);
  const homeSide = useMemo(() => fitView(path.min[0], path.max[0], -path.max[2], -path.min[2]), [path]);
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
    for (let i = 0; i < step; i++) {
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
  }, [step, path, topPaths, sidePaths]);
  const ghost = useMemo(() => topPaths.join(''), [topPaths]);
  const sideGhost = useMemo(() => sidePaths.join(''), [sidePaths]);

  const current = step > 0 ? path.moves[step - 1] : null;
  const here = current ? current.points[current.points.length - 1] : null;
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
            <button onClick={onClose} className="btn-icon w-8 h-8" title={t('common:actions.close')} aria-label={t('common:actions.close')}>
              <X size={15} />
            </button>
          </div>
        </div>

        {total === 0 ? (
          <div className="flex-1 flex items-center justify-center text-sm text-[var(--text-secondary)]">{t('toolpath.noMoves')}</div>
        ) : (
          <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_300px]">
            <div className="min-h-0 flex flex-col">
              {/* Top view */}
              <div className="relative flex-1 min-h-0 bg-[#0A0F19]">
                <span className="absolute left-3 top-2 text-[11px] font-mono text-[#7F8BA0] pointer-events-none">XY ↑</span>
                <div className="absolute right-3 top-2 z-10">
                  <button onClick={() => setView(homeTop)} className="btn-icon w-7 h-7" title={t('toolpath.fit')} aria-label={t('toolpath.fit')}>
                    <Maximize2 size={13} />
                  </button>
                </div>
                <svg
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
                  {here && (
                    <g>
                      <circle cx={here[0]} cy={-here[1]} r={holeR * 2.6} fill="#F3F6FC" fillOpacity={0.15} />
                      <circle cx={here[0]} cy={-here[1]} r={holeR * 1.1} fill="#F3F6FC" stroke={colorOf(current!.tool)} strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
                    </g>
                  )}
                </svg>
              </div>
              {/* Side view */}
              <div className="relative h-32 shrink-0 border-t border-[var(--border-subtle)] bg-[#0A0F19]">
                <span className="absolute left-3 top-2 text-[11px] font-mono text-[#7F8BA0] pointer-events-none">XZ ↕</span>
                <svg className="w-full h-full" viewBox={`${homeSide.x} ${homeSide.y} ${homeSide.w} ${homeSide.h}`} preserveAspectRatio="none">
                  <line x1={homeSide.x} x2={homeSide.x + homeSide.w} y1={0} y2={0} stroke="#3A4762" strokeWidth={1} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
                  <path d={sideGhost} fill="none" stroke="#2A3650" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                  <path d={done.sideRapids.join('')} fill="none" stroke="#7F8BA0" strokeWidth={1} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" opacity={0.7} />
                  {[...done.sideFeeds].map(([tool, parts]) => (
                    <path key={String(tool)} d={parts.join('')} fill="none" stroke={colorOf(tool)} strokeWidth={2} vectorEffect="non-scaling-stroke" />
                  ))}
                  {here && <line x1={here[0]} x2={here[0]} y1={-here[2]} y2={-here[2] - homeSide.h * 0.25} stroke="#F3F6FC" strokeWidth={3} strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
                </svg>
              </div>
            </div>

            {/* Side panel: tools with their colour and time, the current line */}
            <div className="min-h-0 overflow-y-auto border-t lg:border-t-0 lg:border-l border-[var(--border-subtle)] p-4 space-y-4">
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
                        setStep(k >= 0 ? k + 1 : step);
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
                      X{fmtNumber(here[0], 3)} Y{fmtNumber(here[1], 3)} Z{fmtNumber(current.kind === 'drill' ? current.depth ?? here[2] : here[2], 3)}
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
            <button onClick={() => setStep(0)} className="btn-icon w-8 h-8" aria-label={t('toolpath.start')} title={t('toolpath.start')}>
              <SkipBack size={14} />
            </button>
            <button onClick={() => setPlaying((p) => !p)} className="btn-primary w-10 h-10 !p-0 rounded-full justify-center" aria-label={playing ? t('toolpath.pause') : t('toolpath.play')} title={playing ? t('toolpath.pause') : t('toolpath.play')}>
              {playing ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <button onClick={() => setStep(total)} className="btn-icon w-8 h-8" aria-label={t('toolpath.end')} title={t('toolpath.end')}>
              <SkipForward size={14} />
            </button>
            <input
              type="range"
              min={0}
              max={total}
              value={step}
              onChange={(e) => {
                setPlaying(false);
                setStep(Number(e.target.value));
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
