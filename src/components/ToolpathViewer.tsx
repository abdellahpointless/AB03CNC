import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowDownToLine, Pause, Play, Route, SkipBack, SkipForward, Timer, Wrench, X, Maximize2, ShieldCheck, ShieldAlert, Box, RotateCw, Layers, Info, Flame, Ruler, Scissors, PenLine, Eye, Upload, SlidersHorizontal, PanelRight } from 'lucide-react';
import { Popover } from 'radix-ui';
import { parseToolpath, speedsFor, type Move, type Vec } from '../lib/toolpath';
import { hitInstant, toolAt } from '../lib/playback';
import { partLook } from '../lib/partLook';
import { analyseProgram, calesKey, DEFAULT_JAW_HEIGHT, JAW_KEY, readJawHeight, spacerAt, turnMs, viseSpans, type Collision, type SetupInfo } from '../lib/setups';
import { WEAK_COLORS, WEAK_MM, type Jump, type Measurement, type ModelState, type ModelView, type SolidState } from './Toolpath3D';
import { MODEL_MAX_BYTES } from '../lib/modelLimits';
import type { TurnFix } from '../lib/fixTurns';
import { apply, type Mat3 } from '../lib/orient';
import ModelCheck from './ModelCheck';
import type { MeasureMode } from '../lib/measure';
import { iosBackdrop, iosSurface } from '../lib/motion';
import { useT } from '../i18n';
import { fmtDuration, fmtNumber, locale } from '../i18n/format';

const Toolpath3D = lazy(() => import('./Toolpath3D'));
const mm = (v: number) => fmtNumber(Math.round(v * 10) / 10, 1);

const COLORS = ['#5B8CF5', '#F0954F', '#3FB97A', '#C77DFF', '#F2C94C', '#4FD1C5', '#F472B6', '#A3E635'];
const SPEEDS = [5, 10, 50, 250];
const DETAILS_KEY = 'cnc-toolpath-details-v1';
/** The viewer is always dark (like CAM software), also when the app is in light mode. */
const DARK_VARS = {
  '--text-primary': '#EEF1F6',
  '--text-secondary': '#A9B4C7',
  '--text-tertiary': '#7F8BA0',
  '--border-subtle': 'rgba(255,255,255,0.08)',
  '--border-strong': 'rgba(255,255,255,0.18)',
  '--bg-input': '#0A0F19',
  '--ov': '255,255,255',
  '--blue-500': '#3b6fd4',
  '--green-500': '#16a34a',
  '--orange-500': '#e08a4d',
  '--rose-500': '#ff6679',
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

/** Measurements: always two decimals, as on a drawing. */
const fmt2 = (v: number) => v.toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

/** Full-screen toolpath preview: top and side views, one colour per tool, play through the program. */
/** holderHits: holders found going into the part (the remapper's collision check, for this code); focusHit: open at the first collision. */
export default function ToolpathViewer({
  code,
  title,
  brand,
  onClose,
  holderHits,
  focusHit,
  initialModel = null,
  onModelChange,
  onUseFix,
  noRecord = false,
}: {
  code: string;
  title: string;
  brand?: string;
  onClose: () => void;
  holderHits?: Collision[];
  focusHit?: boolean;
  /** The part's 3D PDF or STL given with the program (kept by the editor while it is open). */
  initialModel?: { name: string; bytes: Uint8Array } | null;
  onModelChange?: (m: { name: string; bytes: Uint8Array } | null) => void;
  /** Put the corrected M0 comments into the program in the editor (false: not placed). */
  onUseFix?: (changes: TurnFix['changes']) => boolean;
  /** No learning record from here (the program's maker saved one: CAM AI). */
  noRecord?: boolean;
}) {
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
  const [jawHeight, setJawHeight] = useState(readJawHeight);
  // The turns found by comparing with the model, simulated instead of the program's own (null: the program's).
  const [fixed, setFixed] = useState<Mat3[] | null>(null);
  const program = useMemo(() => analyseProgram(path, { jawHeight: DEFAULT_JAW_HEIGHT }, fixed ?? undefined), [path, fixed]);
  // The jaw height only changes the jaw check, not where the part is: keep the program (and the
  // cut part) when it changes.
  const jawSetups = useMemo(() => (jawHeight === DEFAULT_JAW_HEIGHT ? program.setups : analyseProgram(path, { jawHeight }, fixed ?? undefined).setups), [program, path, jawHeight, fixed]);
  // With the holders that go into the part, each in its setup.
  const setups = useMemo(
    () => (holderHits?.length ? jawSetups.map((s) => ({ ...s, collisions: [...s.collisions, ...holderHits.filter((h) => path.moves[h.move]?.setup === s.index)] })) : jawSetups),
    [jawSetups, holderHits, path],
  );
  // Setup markers above the slider: one that starts too close to the one before goes a row up.
  const markerRows = useMemo(() => {
    let last = -Infinity;
    let lastUp = true;
    return setups.slice(1).map((x) => {
      if (!x.moves) return false;
      const f = x.moves[0] / Math.max(1, path.moves.length);
      // shortcut: a marker is about 9 % of a desktop slider wide; measure the labels if they ever grow.
      const up = f - last < 0.09 && !lastUp;
      last = f;
      lastUp = up;
      return up;
    });
  }, [setups, path]);
  const hitText = (c: Collision) => t(c.what === 'holder' ? 'toolpath.holderJawHit' : c.what === 'holderPart' ? 'toolpath.holderPartHit' : c.what === 'cale' ? 'toolpath.caleHit' : c.what === 'spacer' ? 'toolpath.spacerHit' : 'toolpath.jawHit', { t: c.tool ?? '?', mm: mm(c.depth) });
  // Setups whose written turn and position disagree: an error first, then a caution once inspected.
  const conflicts = setups.filter((x) => x.conflict);
  // Why the program is rejected: a cale the box does not have, a clamping size the part does not have.
  const rejects = setups.flatMap((x) => x.rejects.map((r) => ({ ...r, setup: x.index })));
  const rejectText = (r: (typeof rejects)[number]) =>
    r.kind === 'cale' ? t('toolpath.reject.cale', { mm: fmtNumber(r.mm) }) : t('toolpath.reject.size', { want: fmtNumber(r.want), axis: r.axis, found: fmtNumber(r.found) });
  const [inspectFlip, setInspectFlip] = useState(false);
  const [inspectCale, setInspectCale] = useState(false);
  const [solid, setSolid] = useState<SolidState>({ state: 'off', share: 0 });
  /** While the part turns between setups, the new setup is shown before its first move. */
  const [turning, setTurning] = useState<number | null>(null);
  const multi = setups.length > 1;
  const [mode3d, setMode3d] = useState(true);
  const mode3dRef = useRef(mode3d);
  mode3dRef.current = mode3d;
  // Performance (light, the part catches up with the tool) or details (finer, the tool waits for the cut).
  const [details, setDetails] = useState(() => {
    try {
      return localStorage.getItem(DETAILS_KEY) === '1';
    } catch {
      return false;
    }
  });
  const detailsRef = useRef(details);
  detailsRef.current = details;
  const behind = useRef(false);
  const chooseDetails = (on: boolean) => {
    setDetails(on);
    try {
      localStorage.setItem(DETAILS_KEY, on ? '1' : '0');
    } catch {
      /* private window: the choice lasts until the viewer closes */
    }
  };
  const [fitKey, setFitKey] = useState(0);
  const [isolate, setIsolate] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  // Weak spots: the finished part coloured by wall thickness.
  const [heat, setHeat] = useState(false);
  // Measuring on the part (its faces and holes) and what the last clicks measured.
  const [measure, setMeasure] = useState(false);
  const [measureMode, setMeasureMode] = useState<MeasureMode>('faces');
  const [measured, setMeasured] = useState<Measurement>(null);
  // The real part (3D PDF or STL) laid on the simulated one: kept only while the viewer is open.
  const [model, setModelOwn] = useState<{ name: string; bytes: Uint8Array } | null>(initialModel);
  const setModel = (m: { name: string; bytes: Uint8Array } | null) => {
    setModelOwn(m);
    setFixed(null);
    onModelChange?.(m);
  };
  const [modelName, setModelName] = useState<string | null>(initialModel?.name ?? null);
  const [modelState, setModelState] = useState<ModelState | null>(null);
  const [modelView, setModelView] = useState<ModelView>('both');
  const modelInput = useRef<HTMLInputElement>(null);
  const importModel = async (file: File) => {
    setModel(null);
    setModelName(file.name);
    setModelView('both');
    if (file.size > MODEL_MAX_BYTES) return setModelState({ state: 'error', error: 'tooBig' });
    setModelState({ state: 'reading' });
    setModel({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
  };
  const removeModel = () => {
    setModel(null);
    setModelName(null);
    setModelState(null);
  };
  // The part's material; outlines (on by default for black POM), a section, camera views, a collision to fly to.
  const look = useMemo(() => partLook(code), [code]);
  const [outline, setOutline] = useState(look === 'pom');
  const [seeThrough, setSeeThrough] = useState(false);
  const [section, setSection] = useState<{ axis: 0 | 1 | 2; at: number } | null>(null);
  const [view3d, setView3d] = useState<{ kind: 'top' | 'front' | 'iso'; key: number } | null>(null);
  const [focus, setFocus] = useState<{ point: Vec; key: number } | null>(null);
  // A jump the 3D view hides the part for (to the end, or to a setup change, which then turns).
  const [jump, setJump] = useState<Jump | null>(null);
  // The setup shown is the one of the current move, so playing goes through the setups.
  const currentMove = step > 0 ? path.moves[Math.min(step, total) - 1] : null;
  const sel: SetupInfo | null = setups[turning ?? currentMove?.setup ?? 0] ?? null;
  const range: [number, number] = sel?.moves ?? [0, Math.max(0, total - 1)];
  // A tool into a cale is a warning (yellow), into the spacer it is fine (green), the rest are collisions (red).
  const hardOf = (x: SetupInfo) => x.collisions.filter((c) => c.what !== 'cale' && c.what !== 'spacer');
  const spacersOf = (x: SetupInfo) => x.collisions.filter((c) => c.what === 'spacer');
  const calesOf = (x: SetupInfo) => x.collisions.filter((c) => c.what === 'cale');
  const totalHits = setups.reduce((n, x) => n + hardOf(x).length, 0);
  const totalCales = setups.reduce((n, x) => n + calesOf(x).length, 0);
  const hitByMove = useMemo(() => new Map(setups.flatMap((x) => x.collisions).map((c) => [c.move, c])), [setups]);
  const firstHit = useMemo(() => setups.flatMap((x) => x.collisions).filter((c) => c.what !== 'spacer').sort((p, q) => p.move - q.move)[0] ?? null, [setups]);
  useEffect(() => {
    try {
      localStorage.setItem(JAW_KEY, String(jawHeight));
    } catch {
      /* private mode */
    }
  }, [jawHeight]);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
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
      // Details: the clock waits for the part, so the cut is always shown right where the tool is.
      if (detailsRef.current && mode3dRef.current && behind.current) {
        last = now;
        raf = requestAnimationFrame(tick);
        return;
      }
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
      if (e.defaultPrevented) return; // the View menu closes on Escape first
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

  // The run of moves of the tool at work (tool change to tool change) in this setup: only its path is drawn.
  const run = useMemo(() => {
    const k = Math.min(Math.max(step - 1, range[0]), range[1]);
    const tool = path.moves[k]?.tool;
    let a = k;
    let b = k;
    while (a > range[0] && path.moves[a - 1].tool === tool) a--;
    while (b < range[1] && path.moves[b + 1].tool === tool) b++;
    return [a, b] as const;
  }, [step, path, range[0], range[1]]);
  // Done part grouped by tool and kind, so a long program stays a handful of SVG paths.
  const done = useMemo(() => {
    const feeds = new Map<number | null, string[]>();
    const rapids: string[] = [];
    const sideFeeds = new Map<number | null, string[]>();
    const sideRapids: string[] = [];
    const holes: Move[] = [];
    if (mode3d) return { feeds, rapids, sideFeeds, sideRapids, holes };
    for (let i = run[0]; i < Math.min(step, range[1] + 1); i++) {
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
  }, [step, path, topPaths, sidePaths, run[0], range[1], mode3d]);
  const ghost = useMemo(() => topPaths.slice(run[0], run[1] + 1).join(''), [topPaths, run[0], run[1]]);
  const sideGhost = useMemo(() => sidePaths.slice(run[0], run[1] + 1).join(''), [sidePaths, run[0], run[1]]);
  const goSetup = (s: SetupInfo) => {
    if (!s.moves) return;
    setPlaying(false);
    setMeasure(false);
    seek(s.moves[1] + 1);
  };
  // Jumps the 3D view hides the part for: to the end (the finished part, no turn), or to the start
  // of a setup (the part as the setup before left it, then the turn and the cale change play).
  const jumpEnd = () => {
    setPlaying(false);
    setMeasure(false);
    if (mode3d) setJump({ kind: 'end', from: null, key: Date.now() });
    seek(total);
  };
  const jumpFlip = (s: SetupInfo) => {
    if (!s.moves) return;
    setPlaying(false);
    setMeasure(false);
    if (mode3d) setJump({ kind: 'flip', from: setups[s.index - 1] ?? null, key: Date.now() });
    seek(s.moves[0] + 1);
  };
  // A collision: the part cut up to it, the tool where it hits, the camera close to it.
  const goHit = (c: Collision) => {
    setPlaying(false);
    setMeasure(false);
    setIsolate(false);
    setHeat(false);
    const at = hitInstant(path.moves, c.move, c.point);
    if (mode3d) setJump({ kind: 'end', from: null, key: Date.now() });
    clock.current = at;
    setStep(Math.min(total, Math.ceil(at)));
    setFocus({ point: c.point, key: Date.now() });
  };
  useEffect(() => {
    if (focusHit && firstHit) goHit(firstHit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Measuring: the part just turned (nothing cut yet in this setup) is measured as it is; otherwise
  // the part at the end of this setup (the finished part on the last one).
  const startMeasure = () => {
    setPlaying(false);
    setMeasured(null);
    if (sel?.moves) {
      const [first, last] = sel.moves;
      let cut = false;
      for (let i = first; i < Math.min(Math.ceil(clock.current), last + 1) && !cut; i++) cut = path.moves[i].kind !== 'rapid';
      if (cut) seek(last + 1);
    }
    setMeasure(true);
  };
  // Playing ends measuring (the part changes).
  useEffect(() => {
    if (playing) setMeasure(false);
  }, [playing]);
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
    if (s.restAbove !== null) out.push(t('toolpath.ins.restAbove', { mm: fmtNumber(s.restAbove) }));
    if (s.onJaw !== null) out.push(t('toolpath.ins.onJaw', { mm: fmtNumber(s.onJaw) }));
    for (const sp of s.spacers) out.push(t('toolpath.ins.spacer', { mm: fmtNumber(sp.mm), side: sp.side }));
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
    <motion.div className="fixed inset-0 modal-backdrop flex items-center justify-center p-2.5 z-[99999]" onMouseDown={(e) => e.target === e.currentTarget && onClose()} {...iosBackdrop}>
      <motion.div
        className={`always-dark w-full h-full flex flex-col overflow-hidden rounded-[var(--radius-lg,20px)] border bg-[#0E1421] text-[var(--text-primary)] ${totalHits ? 'border-[#ff4d4d] shadow-[0_0_0_1px_rgba(255,77,77,0.5),0_0_60px_rgba(255,60,60,0.25),0_30px_90px_rgba(0,0,0,0.6)]' : 'border-[var(--border-subtle)] shadow-[0_30px_90px_rgba(0,0,0,0.6)]'}`}
        style={DARK_VARS}
        {...iosSurface}
        role="dialog"
        aria-label={t('toolpath.title')}
      >
        {/* Header: title and the program's key figures as symbols */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-[var(--border-subtle)] flex-wrap">
          {totalHits ? <ShieldAlert size={18} className="text-[#ff6b6b]" /> : <Route size={18} className="text-[var(--accent-primary)]" />}
          <h3 className="font-bold text-[var(--text-primary)]">{t('toolpath.title')}</h3>
          <span className="font-mono text-xs text-[var(--text-tertiary)] truncate max-w-[30ch]">{title}</span>
          {multi && (
          <div className="flex items-center gap-1.5 min-w-0 overflow-x-auto mx-auto" role="tablist" aria-label={t('toolpath.setup', { n: '' })}>
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
                  {s.conflict && <ShieldAlert size={12} className="text-[#f5b942]" aria-label={t('toolpath.conflict.caution', { n: s.index + 1 })} />}
                  {calesOf(s).length > 0 && <span className="badge-warning text-[10px] px-1.5 py-0 font-bold">{calesOf(s).length}</span>}
                  {s.jawTopZ !== null && (hardOf(s).length ? <span className="badge-danger text-[10px] px-1.5 py-0 font-bold">{hardOf(s).length}</span> : <ShieldCheck size={12} className="text-[var(--emerald-500,#3FB97A)]" />)}
                </button>
              );
            })}
          </div>
        )}
          <div className="flex items-center gap-2 ml-auto flex-wrap">
            <span className="inline-flex items-center gap-3 text-xs text-[var(--text-secondary)] tabular-nums pr-1">
              <span className="inline-flex items-center gap-1.5" title={t('toolpath.estimateNote')}><Timer size={13} aria-hidden="true" /> ≈ {fmtDuration(path.totalSeconds)}</span>
              <span className="inline-flex items-center gap-1.5" title={t('toolpath.tools')}><Wrench size={13} aria-hidden="true" /> {path.tools.length}</span>
              {path.lowestZ !== null && <span className="inline-flex items-center gap-1.5 font-mono" title={t('toolpath.lowestZ')}><ArrowDownToLine size={13} aria-hidden="true" /> Z{fmtNumber(path.lowestZ, 2)}</span>}
            </span>
            {(totalHits > 0 || setups.some((x) => x.jawTopZ !== null)) && (
              <span className={`${totalHits ? 'badge-danger' : 'badge-positive'} text-xs py-1 px-2.5 inline-flex items-center gap-1.5`}>
                {totalHits ? <ShieldAlert size={13} /> : <ShieldCheck size={13} />}
                {totalHits ? t('toolpath.jawHits', { count: totalHits }) : t('toolpath.jawClear')}
              </span>
            )}
            {totalCales > 0 && (
              <span className="badge-warning text-xs py-1 px-2.5 inline-flex items-center gap-1.5">
                <ShieldAlert size={13} />
                {t('toolpath.caleHits', { count: totalCales })}
              </span>
            )}
            {rejects.map((r, i) => (
              <span key={`rej${i}`} className="badge-danger text-xs py-1 px-2.5 inline-flex items-center gap-1.5" role="status">
                <ShieldAlert size={13} />
                {r.kind === 'cale' ? t('toolpath.reject.badgeCale', { mm: fmtNumber(r.mm) }) : t('toolpath.reject.badgeSize', { n: r.setup + 1, want: fmtNumber(r.want), axis: r.axis })}
              </span>
            ))}
            {inspectFlip && conflicts.length > 0 && (
              <span className="badge-warning text-xs py-1 px-2.5 inline-flex items-center gap-1.5" role="status">
                <ShieldAlert size={13} />
                {t('toolpath.conflict.caution', { n: conflicts.map((x) => x.index + 1).join(', ') })}
              </span>
            )}
            {path.unsupported.length > 0 && (
              <span
                className="badge-warning text-xs py-1 px-2.5 inline-flex items-center gap-1.5"
                title={path.unsupported.map((u) => t(`toolpath.unsupported.${u.kind}`, { line: u.line + 1, count: u.count })).join('\n')}
              >
                <Info size={13} />
                {t('toolpath.unsupported.title', { count: path.unsupported.length })}
              </span>
            )}
            <button onClick={() => setPanelOpen((x) => !x)} aria-pressed={panelOpen} className="btn-icon w-11 h-11 hidden lg:grid place-items-center" title={t('toolpath.panel')} aria-label={t('toolpath.panel')}>
              <PanelRight size={17} />
            </button>
            <button onClick={onClose} className="btn-icon w-11 h-11" title={t('common:actions.close')} aria-label={t('common:actions.close')}>
              <X size={17} />
            </button>
          </div>
        </div>

        {total === 0 ? (
          <div className="flex-1 flex items-center justify-center text-sm text-[var(--text-secondary)]">{t('toolpath.noMoves')}</div>
        ) : (
          <div className={`flex-1 min-h-0 grid grid-cols-1 grid-rows-[minmax(0,3fr)_minmax(0,2fr)] lg:grid-rows-1 transition-[grid-template-columns] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] ${panelOpen ? 'lg:grid-cols-[1fr_340px]' : 'lg:grid-cols-[1fr_0px]'}`}>
            <div className="min-h-0 flex flex-col">
              {/* Top view */}
              <div className="relative flex-1 min-h-0 bg-[#0A0F19]">
                {mode3d && (
                  <Suspense fallback={null}>
                    <Toolpath3D path={path} program={program} setup={sel} range={range} clock={clock} colorOf={colorOf} fitKey={fitKey} onSolid={setSolid} isolate={isolate || measure} heat={heat} playing={playing} measure={measure} mode={measureMode} onMeasure={setMeasured} jump={jump} look={look} outline={outline} section={section} view={view3d} focus={focus} seeThrough={seeThrough} details={details} behind={behind} model={model} modelView={modelView} onModel={setModelState} />
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
                    <p className="sr-only sm:not-sr-only text-[10px] leading-snug text-[var(--text-tertiary)]">{t('toolpath.heatNote')}</p>
                  </div>
                )}
                {mode3d && !isolate && !measure && sel?.cales?.length && sel.support !== null ? (() => {
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
                {mode3d && measure && solid.state === 'ready' && (
                  <div className="absolute left-3 bottom-3 z-10 w-72 max-w-[calc(100%-1.5rem)] rounded-[var(--radius-md,12px)] border border-[var(--border-subtle)] bg-[#0E1421]/90 px-3 py-2 space-y-1.5">
                    <div className="inline-flex rounded-full border border-[var(--border-subtle)] p-0.5" role="radiogroup" aria-label={t('toolpath.measure')}>
                      {(['faces', 'points', 'diameter', 'axes'] as const).map((m) => (
                        <button key={m} role="radio" aria-checked={measureMode === m} onClick={() => setMeasureMode(m)} className={`px-2.5 h-6 rounded-full text-[11px] font-bold ${measureMode === m ? 'bg-[#22d3ee] text-[#062a33]' : 'text-[var(--text-secondary)]'}`}>
                          {t(`toolpath.measureMode.${m}`)}
                        </button>
                      ))}
                    </div>
                    <div aria-live="polite" className="text-[11px] text-[var(--text-secondary)] space-y-1">
                      {measured?.kind === 'hole' ? (
                        <>
                          <div className="font-mono text-base font-bold text-[var(--text-primary)]">Ø {fmt2(measured.mm)} mm</div>
                          <div>
                            {t('toolpath.measureHoleDepth', { depth: fmt2(measured.depth) })}
                            {measured.tool && <span className="font-mono"> · {measured.tool}</span>}
                          </div>
                        </>
                      ) : measured?.kind === 'distance' ? (
                        <>
                          <div className="font-mono text-base font-bold text-[var(--text-primary)]">{fmt2(measured.mm)} mm</div>
                          {measured.d && (
                            <div className="font-mono">
                              ΔX {fmt2(Math.abs(measured.d[0]))} · ΔY {fmt2(Math.abs(measured.d[1]))} · ΔZ {fmt2(Math.abs(measured.d[2]))}
                            </div>
                          )}
                        </>
                      ) : measured?.kind === 'none' || measured?.kind === 'notParallel' ? (
                        <div className="text-[#FFD27A]">{t(measured.kind === 'none' ? 'toolpath.measureNone' : 'toolpath.measureNotParallel')}</div>
                      ) : null}
                      <div>{measured?.kind === 'picked' || measured?.kind === 'notParallel' ? t('toolpath.measureSecond') : t(`toolpath.measureHint.${measureMode}`)}</div>
                      <p className="text-[10px] text-[var(--text-tertiary)]">{t('toolpath.measureNote')}</p>
                    </div>
                  </div>
                )}
                {/* Rejected (a cale the box does not have, a size the part does not have): each with its line and two lines either side. */}
                {rejects.length > 0 && !inspectCale && (
                  <div role="alertdialog" aria-labelledby="reject-title" className="absolute inset-0 z-20 flex items-center justify-center bg-[#0E1421]/80 backdrop-blur-md p-6">
                    <div className="max-w-lg w-full max-h-full overflow-y-auto rounded-[var(--radius-md,12px)] border border-[#ff4d4d] bg-[#1a0b0e] p-4 space-y-3 shadow-[0_0_40px_rgba(255,60,60,0.25)]">
                      <div id="reject-title" className="flex items-center gap-2 text-sm font-semibold text-[#ffc2c2]">
                        <ShieldAlert size={16} aria-hidden="true" />
                        {t('toolpath.reject.title')}
                      </div>
                      {rejects.map((r, k) => {
                        const from = Math.max(0, r.line - 2);
                        return (
                          <div key={k} className="text-xs space-y-1">
                            <p className="text-[var(--text-secondary)]">{rejectText(r)}</p>
                            <div className="font-semibold text-[var(--text-primary)]">{t('toolpath.reject.line', { n: r.setup + 1, line: r.line + 1 })}</div>
                            <pre className="font-mono text-[11px] leading-5 rounded bg-black/40 px-2 py-1 overflow-x-auto">
                              {lines.slice(from, r.line + 3).map((l, i) => (
                                <div key={i} className={from + i === r.line ? 'text-[#ffc2c2] bg-[#ff4d4d]/20' : 'text-[var(--text-secondary)]'}>
                                  {String(from + i + 1).padStart(5, ' ')}  {l}
                                </div>
                              ))}
                            </pre>
                          </div>
                        );
                      })}
                      <button type="button" onClick={() => setInspectCale(true)} className="btn-secondary text-xs py-1.5 px-3">
                        {t('toolpath.conflict.inspect')}
                      </button>
                    </div>
                  </div>
                )}
                {/* A flip the program writes in two ways that disagree: not possible as written. */}
                {conflicts.length > 0 && !inspectFlip && (rejects.length === 0 || inspectCale) && (
                  <div role="alertdialog" aria-labelledby="flip-conflict-title" aria-describedby="flip-conflict-body" className="absolute inset-0 z-20 flex items-center justify-center bg-[#0E1421]/80 backdrop-blur-md p-6">
                    <div className="max-w-md w-full rounded-[var(--radius-md,12px)] border border-[#ff4d4d] bg-[#1a0b0e] p-4 space-y-3 shadow-[0_0_40px_rgba(255,60,60,0.25)]">
                      <div id="flip-conflict-title" className="flex items-center gap-2 text-sm font-semibold text-[#ffc2c2]">
                        <ShieldAlert size={16} aria-hidden="true" />
                        {t('toolpath.conflict.title')}
                      </div>
                      <p id="flip-conflict-body" className="text-xs text-[var(--text-secondary)]">{t('toolpath.conflict.body')}</p>
                      {conflicts.map((x) => (
                        <div key={x.index} className="text-xs space-y-0.5">
                          <div className="font-semibold text-[var(--text-primary)]">{t('toolpath.conflict.line', { n: x.index + 1, line: x.line + 1 })}</div>
                          <div className="font-mono text-[11px] text-[#ffa3a3] break-words">{x.notes.map((n) => `(${n})`).join(' ')}</div>
                        </div>
                      ))}
                      <button type="button" onClick={() => setInspectFlip(true)} className="btn-secondary text-xs py-1.5 px-3">
                        {t('toolpath.conflict.inspect')}
                      </button>
                    </div>
                  </div>
                )}
                {/* The part stays veiled until it is cut and shown, and while its walls are measured. */}
                <AnimatePresence>
                  {mode3d && (solid.state === 'carving' || solid.state === 'meshing' || solid.state === 'measuring' || solid.state === 'analysing' || solid.state === 'jumping') && (
                    <motion.div
                      key="veil"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0, scale: 1.02, transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] } }}
                      className="absolute inset-0 z-[5] flex items-center justify-center bg-[#0E1421]/70 backdrop-blur-xl"
                      role="status"
                      aria-live="polite"
                    >
                      <div className="flex flex-col items-center gap-3">
                        <span className="relative w-12 h-12" aria-hidden="true">
                          <span className="absolute inset-0 rounded-full border-2 border-[rgba(var(--ov),0.12)]" />
                          <span className="absolute inset-0 rounded-full border-2 border-transparent border-t-[var(--accent-primary)] animate-spin motion-reduce:animate-none" />
                          <Box size={18} className="absolute inset-0 m-auto text-[var(--accent-primary)]" />
                        </span>
                        <span className="text-xs font-semibold text-[var(--text-primary)]">{t(`toolpath.${solid.state}`)}</span>
                        <span className="w-40 h-1 rounded-full bg-[rgba(var(--ov),0.1)] overflow-hidden" aria-hidden="true">
                          <motion.span
                            className="block h-full bg-[var(--accent-primary)]"
                            animate={{ width: `${Math.round((solid.state === 'carving' ? solid.share * 0.8 : solid.state === 'meshing' ? 0.9 : 0.95) * 100)}%` }}
                            transition={{ duration: 0.3 }}
                          />
                        </span>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
                <div className="tp-bar absolute left-3 right-3 top-3 z-10 flex items-center gap-2 flex-wrap">
                  <div className="inline-flex rounded-full border border-[var(--border-subtle)] bg-[#0E1421]/80 p-0.5" role="radiogroup" aria-label="3D / 2D">
                    {[true, false].map((m) => (
                      <button key={String(m)} role="radio" aria-checked={mode3d === m} onClick={() => setMode3d(m)} className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold ${mode3d === m ? 'bg-[var(--accent-primary)] text-white' : 'text-[var(--text-secondary)]'}`}>
                        {m ? t('toolpath.view3d') : t('toolpath.view2d')}
                      </button>
                    ))}
                  </div>
                  {mode3d && (
                    <>
                      <span className="w-px h-5 bg-[var(--border-subtle)]" aria-hidden="true" />
{mode3d && (
                    <button
                      onClick={() => (measure ? setMeasure(false) : startMeasure())}
                      aria-pressed={!!measure}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 h-7 text-[11px] font-semibold ${measure ? 'border-[#22d3ee] bg-[#22d3ee] text-[#062a33]' : 'border-[var(--border-subtle)] bg-[#0E1421]/80 text-[var(--text-secondary)]'}`}
                      title={t('toolpath.measureHelp')}
                    >
                      <Ruler size={12} />
                      <span className="sr-only sm:not-sr-only">{t('toolpath.measure')}</span>
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
                      <span className="sr-only sm:not-sr-only">{t('toolpath.heat')}</span>
                    </button>
                  )}
{mode3d && (
                    <button
                      onClick={() => setSection((x) => (x ? null : { axis: 1, at: 0.5 }))}
                      aria-pressed={!!section}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 h-7 text-[11px] font-semibold ${section ? 'border-[#e07a5f] bg-[#e07a5f] text-[#2a0f08]' : 'border-[var(--border-subtle)] bg-[#0E1421]/80 text-[var(--text-secondary)]'}`}
                      title={t('toolpath.sectionHelp')}
                    >
                      <Scissors size={12} />
                      <span className="sr-only sm:not-sr-only">{t('toolpath.section')}</span>
                    </button>
                  )}
                      <span className="w-px h-5 bg-[var(--border-subtle)]" aria-hidden="true" />
                      <div className="inline-flex rounded-full border border-[var(--border-subtle)] bg-[#0E1421]/80 p-0.5" role="group" aria-label={t('toolpath.views')}>
                      {(['top', 'front', 'iso'] as const).map((k) => (
                        <button key={k} onClick={() => setView3d({ kind: k, key: Date.now() })} className="px-2.5 h-6 rounded-full text-[11px] font-semibold text-[var(--text-secondary)] hover:bg-[rgba(var(--ov),0.08)] hover:text-[var(--text-primary)]">
                          {t(`toolpath.viewKind.${k}`)}
                        </button>
                      ))}
                    </div>
                      <Popover.Root>
                        <Popover.Trigger className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[#0E1421]/80 px-3 h-9 text-xs font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] data-[state=open]:border-[var(--accent-primary)]">
                          <SlidersHorizontal size={13} aria-hidden="true" /> {t('toolpath.viewMenu')}
                        </Popover.Trigger>
                        <Popover.Content align="start" sideOffset={8} className="tp-menu z-20 w-56 rounded-[var(--radius-md,12px)] border border-[var(--border-strong)] bg-[#0E1421]/95 p-2 backdrop-blur-xl shadow-[0_16px_48px_rgba(0,0,0,0.5)]">
{mode3d && (
                    <button
                      onClick={() => setIsolate((x) => !x)}
                      aria-pressed={isolate}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 h-7 text-[11px] font-semibold ${isolate ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)] text-white' : 'border-[var(--border-subtle)] bg-[#0E1421]/80 text-[var(--text-secondary)]'}`}
                      title={t('toolpath.isolateHelp')}
                    >
                      <Box size={12} />
                      <span className="sr-only sm:not-sr-only">{t('toolpath.isolate')}</span>
                    </button>
                  )}
{mode3d && (
                    <button
                      onClick={() => setOutline((x) => !x)}
                      aria-pressed={outline}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 h-7 text-[11px] font-semibold ${outline ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)] text-white' : 'border-[var(--border-subtle)] bg-[#0E1421]/80 text-[var(--text-secondary)]'}`}
                      title={t('toolpath.outlineHelp')}
                    >
                      <PenLine size={12} />
                      <span className="sr-only sm:not-sr-only">{t('toolpath.outline')}</span>
                    </button>
                  )}
{mode3d && !(isolate || measure) && (
                    <button
                      onClick={() => setSeeThrough((x) => !x)}
                      aria-pressed={seeThrough}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 h-7 text-[11px] font-semibold ${seeThrough ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)] text-white' : 'border-[var(--border-subtle)] bg-[#0E1421]/80 text-[var(--text-secondary)]'}`}
                      title={t('toolpath.seeThroughHelp')}
                    >
                      <Eye size={12} />
                      <span className="sr-only sm:not-sr-only">{t('toolpath.seeThrough')}</span>
                    </button>
                  )}
{mode3d && (
                    <>
                      <button
                        onClick={() => modelInput.current?.click()}
                        className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[#0E1421]/80 px-2.5 h-7 text-[11px] font-semibold text-[var(--text-secondary)]"
                        title={t('toolpath.model.importHelp')}
                      >
                        <Upload size={12} />
                        <span className="sr-only sm:not-sr-only">{t('toolpath.model.import')}</span>
                      </button>
                      <input
                        ref={modelInput}
                        type="file"
                        accept=".pdf,.stl"
                        hidden
                        aria-label={t('toolpath.model.import')}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.target.value = '';
                          if (f) void importModel(f);
                        }}
                      />
                    </>
                  )}
                          <div className="inline-flex rounded-full border border-[var(--border-subtle)] bg-[#0E1421]/80 p-0.5" role="radiogroup" aria-label={t('toolpath.quality.label')} title={t('toolpath.quality.help')}>
                      {[false, true].map((d) => (
                        <button key={String(d)} role="radio" aria-checked={details === d} onClick={() => chooseDetails(d)} className={`px-2.5 h-6 rounded-full text-[11px] font-semibold ${details === d ? 'bg-[var(--accent-primary)] text-white' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}>
                          {d ? t('toolpath.quality.details') : t('toolpath.quality.performance')}
                        </button>
                      ))}
                    </div>
                        </Popover.Content>
                      </Popover.Root>
                    </>
                  )}
<button onClick={() => (mode3d ? setFitKey((k) => k + 1) : setView(homeTop))} className="btn-icon w-7 h-7" title={t('toolpath.fit')} aria-label={t('toolpath.fit')}>
                    <Maximize2 size={13} />
                  </button>
                </div>
                {mode3d && modelName && (
                  <div className="absolute right-3 top-20 z-10 flex items-center gap-2">
                    <div aria-live="polite" className={`inline-flex items-center gap-1.5 max-w-[34rem] rounded-full border bg-[#0E1421]/90 pl-2.5 pr-1 h-7 text-[11px] font-semibold ${modelState?.state === 'error' ? 'border-[#ff6b6b] text-[#ffb4b4]' : 'border-[var(--border-subtle)] text-[var(--text-secondary)]'}`}>
                      <span className="truncate max-w-[10rem]">{modelName}</span>
                      <span className="shrink-0">
                        {'· '}
                        {modelState?.state === 'error'
                          ? t(`toolpath.model.errors.${modelState.error}`)
                          : modelState?.state === 'ready'
                            ? t('toolpath.model.ready', { pct: fmtNumber(Math.floor(modelState.match * 1000) / 10) })
                            : t('toolpath.model.reading')}
                      </span>
                      <button onClick={removeModel} className="btn-icon w-5 h-5 shrink-0" title={t('toolpath.model.remove')} aria-label={t('toolpath.model.remove')}>
                        <X size={11} />
                      </button>
                    </div>
                    {modelState?.state === 'ready' && (
                      <div className="inline-flex rounded-full border border-[var(--border-subtle)] bg-[#0E1421]/80 p-0.5" role="radiogroup" aria-label={t('toolpath.model.view')}>
                        {(['part', 'model', 'both'] as const).map((v) => (
                          <button key={v} role="radio" aria-checked={modelView === v} onClick={() => setModelView(v)} className={`px-2.5 h-6 rounded-full text-[11px] font-semibold ${modelView === v ? 'bg-[#8fb3e0] text-[#0b1a2e]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}>
                            {t(`toolpath.model.${v}`)}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {mode3d && section && (
                  <div className="absolute left-3 top-2 z-10 w-60 rounded-[var(--radius-md,12px)] border border-[var(--border-subtle)] bg-[#0E1421]/90 px-3 py-2 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <Scissors size={12} className="text-[#e07a5f]" aria-hidden="true" />
                      <span className="text-[11px] font-semibold text-[var(--text-primary)]">{t('toolpath.section')}</span>
                      <div className="ml-auto inline-flex rounded-full border border-[var(--border-subtle)] p-0.5" role="radiogroup" aria-label={t('toolpath.sectionAxis')}>
                        {([0, 1, 2] as const).map((ax) => (
                          <button key={ax} role="radio" aria-checked={section.axis === ax} onClick={() => setSection({ ...section, axis: ax })} className={`w-7 h-6 rounded-full text-[11px] font-mono font-bold ${section.axis === ax ? 'bg-[#e07a5f] text-[#2a0f08]' : 'text-[var(--text-secondary)]'}`}>
                            {'XYZ'[ax]}
                          </button>
                        ))}
                      </div>
                    </div>
                    <input type="range" min={0} max={100} value={Math.round(section.at * 100)} onChange={(e) => setSection({ ...section, at: Number(e.target.value) / 100 })} aria-label={t('toolpath.sectionAt')} className="w-full h-5 accent-[#e07a5f]" />
                  </div>
                )}
                {mode3d && current && hitByMove.get(step - 1) && (
                  <div className={`absolute left-1/2 -translate-x-1/2 top-[4.5rem] z-10 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold whitespace-nowrap ${hitByMove.get(step - 1)!.what === 'spacer' ? 'border-[#34d399] bg-[#0b2a1f]/95 text-[#b5f5d8] shadow-[0_0_24px_rgba(52,211,153,0.3)]' : hitByMove.get(step - 1)!.what === 'cale' ? 'border-[#f5b942] bg-[#2e2208]/95 text-[#ffe2a3] shadow-[0_0_24px_rgba(245,185,66,0.3)]' : 'border-[#ff4d4d] bg-[#3a0d10]/95 text-[#ffc2c2] shadow-[0_0_24px_rgba(255,60,60,0.35)]'}`}>
                    <ShieldAlert size={14} aria-hidden="true" />#{hitByMove.get(step - 1)!.line + 1} · {hitText(hitByMove.get(step - 1)!)}
                  </div>
                )}
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
                        viseSpans(sel).flatMap(([x0, x1], v) =>
                          [[sel.stock!.max[1] + spacerAt(sel, 'Y+'), sel.stock!.max[1] + spacerAt(sel, 'Y+') + 24], [sel.stock!.min[1] - spacerAt(sel, 'Y-') - 24, sel.stock!.min[1] - spacerAt(sel, 'Y-')]].map(([a, b], i) => (
                            <rect key={`${v}-${i}`} x={x0} y={-b} width={x1 - x0} height={b - a} fill="#5A6A82" fillOpacity={0.35} stroke="#7F8BA0" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                          )),
                        )}
                      {sel.jawTopZ !== null &&
                        sel.spacers.map(({ mm, side }) => {
                          // A spacer plate between the part and a jaw or the stop.
                          const st = sel.stock!;
                          const [x0, x1, y0, y1] =
                            side === 'Y-' ? [sel.jawX[0], sel.jawX[1], st.min[1] - mm, st.min[1]] : side === 'Y+' ? [sel.jawX[0], sel.jawX[1], st.max[1], st.max[1] + mm] : side === 'X-' ? [st.min[0] - mm, st.min[0], st.min[1], st.max[1]] : [0, 0, 0, 0];
                          return x1 > x0 && <rect key={side} x={x0} y={-y1} width={x1 - x0} height={y1 - y0} fill="#C9D3E0" fillOpacity={0.25} stroke="#C9D3E0" strokeOpacity={0.6} strokeDasharray="3 2" strokeWidth={1} vectorEffect="non-scaling-stroke" />;
                        })}
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
                    <circle key={`hit${i}`} cx={c.point[0]} cy={-c.point[1]} r={holeR * 1.6} fill={c.what === 'spacer' ? '#34D399' : c.what === 'cale' ? '#F5B942' : '#FF4D4D'} fillOpacity={0.85} />
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
            <div inert={!panelOpen} aria-hidden={!panelOpen} className={`min-h-0 min-w-0 overflow-y-auto border-t lg:border-t-0 lg:border-l border-[var(--border-subtle)] p-4 space-y-4 transition-opacity duration-200 ${panelOpen ? '' : 'lg:opacity-0 lg:p-0 lg:border-l-0'}`}>
              {model && mode3d && (
                <ModelCheck
                  record={!noRecord}
                  model={model}
                  state={modelState}
                  code={code}
                  brand={brand}
                  fileName={title}
                  path={path}
                  using={!!fixed}
                  onSimulate={(o) => {
                    setFixed(o);
                    seek(0);
                  }}
                  onFocus={(p) => sel && setFocus({ point: apply(sel.orient, p).map((v, k) => v + sel.offset[k]) as Vec, key: Date.now() })}
                  onUseFix={onUseFix}
                />
              )}
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
                    <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-[var(--text-secondary)]">
                      {t('toolpath.part', { x: mm(sel.stock.max[0] - sel.stock.min[0]), y: mm(sel.stock.max[1] - sel.stock.min[1]), z: mm(sel.stock.max[2] - sel.stock.min[2]) })}
                      {look !== 'plain' && <span className="badge-neutral font-sans text-[10px] py-0.5 px-2">{t(`toolpath.material.${look}`)}</span>}
                    </div>
                  )}
                  <details className="text-[11px] text-[var(--text-tertiary)]">
                    <summary className="cursor-pointer select-none">{t('toolpath.original')}</summary>
                    <div className="font-mono mt-1 space-y-0.5 break-words">{sel.notes.map((n, i) => <div key={i}>({n})</div>)}</div>
                  </details>
                  {hardOf(sel).length > 0 && (
                    <div className="space-y-1 pt-1 border-t border-[var(--border-subtle)]">
                      <div className="badge-danger text-xs py-1 px-2.5 inline-flex items-center gap-1.5"><ShieldAlert size={13} />{t('toolpath.jawHits', { count: hardOf(sel).length })}</div>
                      {hardOf(sel).slice(0, 8).map((c, i) => (
                        <button key={i} type="button" onClick={() => goHit(c)} className="w-full text-left text-[11px] font-mono text-[#FF8A8A] hover:underline">
                          #{c.line + 1} · {hitText(c)}
                        </button>
                      ))}
                    </div>
                  )}
                  {calesOf(sel).length > 0 && (
                    <div className="space-y-1 pt-1 border-t border-[var(--border-subtle)]">
                      <div className="badge-warning text-xs py-1 px-2.5 inline-flex items-center gap-1.5"><ShieldAlert size={13} />{t('toolpath.caleHits', { count: calesOf(sel).length })}</div>
                      {calesOf(sel).slice(0, 8).map((c, i) => (
                        <button key={i} type="button" onClick={() => goHit(c)} className="w-full text-left text-[11px] font-mono text-[#FFD27A] hover:underline">
                          #{c.line + 1} · {hitText(c)}
                        </button>
                      ))}
                    </div>
                  )}
                  {spacersOf(sel).length > 0 && (
                    <div className="space-y-1 pt-1 border-t border-[var(--border-subtle)]">
                      <div className="badge-positive text-xs py-1 px-2.5 inline-flex items-center gap-1.5"><ShieldCheck size={13} />{t('toolpath.spacerHits', { count: spacersOf(sel).length })}</div>
                      {spacersOf(sel).slice(0, 8).map((c, i) => (
                        <button key={i} type="button" onClick={() => goHit(c)} className="w-full text-left text-[11px] font-mono text-[#7FE3B8] hover:underline">
                          #{c.line + 1} · {hitText(c)}
                        </button>
                      ))}
                    </div>
                  )}
                  {sel.jawTopZ !== null ? (
                    <div className="space-y-2 pt-1 border-t border-[var(--border-subtle)]">
                      {hardOf(sel).length ? null : (
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
                      className={`w-full block text-left rounded-[var(--radius-sm)] px-2.5 py-2 border transition-colors ${active ? 'border-[var(--border-strong)] bg-[rgba(var(--ov),0.06)]' : 'border-transparent hover:bg-[rgba(var(--ov),0.04)]'}`}
                    >
                      <span className="flex items-center gap-2.5">
                        <span className="w-3 h-3 rounded-full shrink-0" style={{ background: colorOf(tl.tool) }} />
                        <span className="font-mono text-xs font-bold text-[var(--text-primary)] flex-1">T{tl.tool}</span>
                        <span className="font-mono text-[11px] text-[var(--text-tertiary)] shrink-0">{fmtClock(tl.seconds)}</span>
                      </span>
                      <span className="block pl-[22px] mt-0.5 text-xs text-[var(--text-secondary)] break-words">{tl.label}</span>
                      <span className="block pl-[22px] font-mono text-[11px] text-[var(--text-tertiary)]">
                        {t('toolpath.toolSize', { d: tl.diameter === null ? '—' : fmt2(tl.diameter), l: tl.length === null ? '—' : fmt2(tl.length) })}
                      </span>
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
          <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 sm:gap-3 px-3 sm:px-5 py-3 border-t border-[var(--border-subtle)]">
            <button onClick={() => seek(0)} className="btn-icon w-8 h-8" aria-label={t('toolpath.start')} title={t('toolpath.start')}>
              <SkipBack size={14} />
            </button>
            <button onClick={() => setPlaying((p) => !p)} className="btn-primary shrink-0 w-10 h-10 !p-0 rounded-full justify-center" aria-label={playing ? t('toolpath.pause') : t('toolpath.play')} title={playing ? t('toolpath.pause') : t('toolpath.play')}>
              {playing ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <button onClick={jumpEnd} className="btn-icon w-8 h-8" aria-label={t('toolpath.end')} title={t('toolpath.end')}>
              <SkipForward size={14} />
            </button>
            <div className={`order-first basis-full sm:order-none sm:basis-0 flex-1 min-w-0 relative ${markerRows.some((r) => r) ? 'sm:pt-14' : 'sm:pt-7'}`}>
              {/* Where the part turns, with its new cales: a click goes there and plays the turn. */}
              {multi &&
                setups.slice(1).map((s, i) => {
                  if (!s.moves) return null;
                  const f = s.moves[0] / total;
                  // A marker that would cover the one before it goes on the row above, with a longer tick.
                  const up = markerRows[i];
                  return (
                    <button
                      key={s.index}
                      onClick={() => jumpFlip(s)}
                      aria-label={t('toolpath.jumpTo', { n: s.index + 1 })}
                      title={t('toolpath.jumpTo', { n: s.index + 1 })}
                      className={`no-glass hidden sm:inline-flex -translate-x-1/2 items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-[#0E1421] px-2 h-6 text-[11px] font-mono text-[var(--text-secondary)] hover:border-[var(--accent-primary)] hover:text-[var(--text-primary)] whitespace-nowrap after:absolute after:left-1/2 after:top-full after:w-px after:bg-[var(--border-strong)] ${up || !markerRows.some((r) => r) ? 'top-0' : 'top-7'} ${up ? 'after:h-8' : 'after:h-1.5'}`}
                      // The app's button style makes every button relative: placed here, over it.
                      style={{ position: 'absolute', left: `calc(${f * 100}% + ${(0.5 - f) * 16}px)` }}
                    >
                      <span className="font-bold text-[var(--text-primary)]">{s.index + 1}</span>
                      {s.rotation && (
                        <span className="inline-flex items-center gap-0.5">
                          <RotateCw size={10} aria-hidden="true" />
                          {s.rotation.deg}° {s.rotation.axis}
                        </span>
                      )}
                      {s.support !== null && <span>▭{fmtNumber(s.support)}</span>}
                    </button>
                  );
                })}
              <input
                type="range"
                min={0}
                max={total}
                value={step}
                onChange={(e) => {
                  setPlaying(false);
                  setMeasure(false);
                  const n = Number(e.target.value);
                  if (n === total) jumpEnd();
                  else seek(n);
                }}
                onPointerUp={(e) => {
                  // Let go next to a setup change: go to it and play the turn.
                  const n = Number((e.target as HTMLInputElement).value);
                  const near = setups.slice(1).find((s) => s.moves && n !== total && Math.abs(n - s.moves[0]) <= Math.max(1, total * 0.006));
                  if (near) jumpFlip(near);
                }}
                className="w-full h-6 accent-[var(--accent-primary)]"
                aria-label={t('toolpath.position')}
              />
            </div>
            <span className="font-mono text-xs text-[var(--text-secondary)] sm:w-28 text-right">
              {fmtClock(elapsed)} / {fmtClock(path.totalSeconds)}
            </span>
            <div className="ml-auto sm:ml-0 inline-flex rounded-full border border-[var(--border-subtle)] p-0.5" role="radiogroup" aria-label={t('toolpath.speed')}>
              {SPEEDS.map((s, i) => (
                <button key={s} role="radio" aria-checked={speed === i} onClick={() => setSpeed(i)} className={`px-2 h-6 rounded-full text-[11px] font-mono font-bold ${speed === i ? 'bg-[var(--accent-primary)] text-white' : 'text-[var(--text-secondary)]'}`}>
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
