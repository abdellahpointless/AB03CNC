/*
 * CAM AI's own simulation (you: "a special tool with its own simulation"): the made program played in CAM AI's
 * viewport, with its own chrome — one floating toolbar, two corner chips, a timeline with one segment per tool.
 * The engine is the app's (parseToolpath, analyseProgram, usePlayback, Toolpath3D), so what is checked is what is shown.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  IconCameraRotate as CameraRotate,
  IconChevronDown as ChevronDown,
  IconEye as Eye,
  IconFocusCentered as Fit,
  IconPlayerPauseFilled as Pause,
  IconPlayerPlayFilled as Play,
  IconPlayerTrackNextFilled as NextTool,
  IconPlayerTrackPrevFilled as PrevTool,
  IconRulerMeasure as Measure,
  IconShieldCheck as ShieldCheck,
  IconShieldX as ShieldX,
  IconSlice as Slice,
  IconStack2 as Parallels,
  IconWall as Wall,
} from '@tabler/icons-react';
import { Popover } from 'radix-ui';
import { parseToolpath, speedsFor, type Vec } from '../lib/toolpath';
import { analyseProgram, DEFAULT_JAW_HEIGHT, jawsFrom, type SetupInfo } from '../lib/setups';
import { partLook } from '../lib/partLook';
import { SPEEDS, usePlayback, type PlayGate } from '../lib/usePlayback';
import type { MeasureMode } from '../lib/measure';
import type { Jump, Measurement, ModelState, ModelView, SolidState } from './Toolpath3D';
import { useTranslation } from 'react-i18next';

const Toolpath3D = lazy(() => import('./Toolpath3D'));

/** One colour per tool, as the app's other views give them. */
export const COLORS = ['#5B8CF5', '#F0954F', '#3FB97A', '#C77DFF', '#F2C94C', '#4FD1C5', '#F472B6', '#A3E635'];
const clockText = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** play with a tool: that tool's run in that clamping played alone (it stops at the run's end). */
export type SimFocus = { setup: number; tool?: number; key: number; play?: boolean };

export default function CamSim({
  code,
  brand,
  model,
  focus,
  selected,
  runLabel,
  stepLabel,
  parallels,
  nx,
  measure,
  onMeasureToggle,
  onModel,
  onPickTool,
  preview = null,
}: {
  code: string;
  brand?: string;
  /** The part's own model (laid over the simulated part: Show). */
  model: { name: string; bytes: Uint8Array } | null;
  /** The page asks for a tool at work (its first move in that clamping, paused) or a clamping as it starts. */
  focus: SimFocus | null;
  /** The tool picked in the page (its segments stay bright), and its clamping. */
  selected: { setup: number; tool: number } | null;
  /** What a run of a tool does (the timeline's tooltip): "T28 · End mill — Outline roughing". */
  runLabel: (setup: number, tool: number | null) => string;
  /** A clamping's tick under the timeline: "OP10 · Vise · 41". */
  stepLabel: (setup: number) => string;
  /** A clamping's corner chip: "41 mm parallels". */
  parallels: (setup: number) => string;
  /** The NX view: every path over the finished part, nothing cut away. */
  nx: boolean;
  measure: { on: boolean; mode: MeasureMode; onMeasure: (m: Measurement) => void };
  onMeasureToggle: () => void;
  /** How the simulated part compares with the model, when one is laid over it. */
  onModel?: (s: ModelState) => void;
  /** A tool's path clicked in the 3D view: that tool, in the clamping shown. */
  onPickTool?: (setup: number, tool: number) => void;
  /** A clamping's parallels and spacers as asked (item 3), drawn there until the program is made again. */
  preview?: { setup: number; cale?: number; stop?: number; y?: number } | null;
}) {
  const { t } = useTranslation('cam');
  const path = useMemo(() => parseToolpath(code, speedsFor(brand)), [code, brand]);
  const program = useMemo(() => analyseProgram(path, { jawHeight: DEFAULT_JAW_HEIGHT }), [path]);
  const setups = program.setups;
  const gate = useRef<PlayGate>({ wait: () => false, mode3d: () => true });
  // One tool's run played alone: the move playback stops before.
  const soloEnd = useRef<number | null>(null);
  const { total, clock, step, setStep, seek, turning, playing, setPlaying, speed, setSpeed, timeline, elapsed } = usePlayback(path, setups, gate);
  gate.current = { wait: () => false, mode3d: () => true, end: () => soloEnd.current };
  const [heat, setHeat] = useState(false);
  const [section, setSection] = useState<{ axis: 0 | 1 | 2; at: number; follow?: boolean } | null>(null);
  const [view3d, setView3d] = useState<{ kind: 'top' | 'front' | 'iso'; key: number } | null>(null);
  const [fitKey, setFitKey] = useState(0);
  const [modelView, setModelView] = useState<ModelView>('part');
  const [, setSolid] = useState<SolidState>({ state: 'off', share: 0 });
  const [jump, setJump] = useState<Jump | null>(null);
  const [, setModelState] = useState<ModelState | null>(null);
  const behind = useRef(false);
  const shell = useRef<HTMLDivElement>(null);
  const look = useMemo(() => partLook(code), [code]);
  const colorOf = useMemo(() => {
    const map = new Map<number | null, string>();
    path.tools.forEach((tl, i) => map.set(tl.tool, COLORS[i % COLORS.length]));
    return (tool: number | null) => map.get(tool) ?? '#9AA6BA';
  }, [path]);

  const currentMove = step > 0 ? path.moves[Math.min(step, total) - 1] : null;
  const made: SetupInfo | null = setups[turning ?? currentMove?.setup ?? 0] ?? null;
  // The asked hold drawn in place of the made one: the part where it is, the vise and its parallels round it.
  const sel = useMemo((): SetupInfo | null => {
    const p = preview;
    if (!made || !p || made.index !== p.setup || made.floorZ === null || made.jawTopZ === null || made.restZ === null) return made;
    const s: SetupInfo = { ...made };
    if (p.cale !== undefined && made.onJaw === null) {
      s.floorZ = made.restZ! - p.cale;
      s.jawTopZ = s.floorZ + (made.jawTopZ! - made.floorZ!);
      s.support = p.cale;
      s.cales = p.cale > 0 && made.cales ? made.cales.map((c) => ({ ...c, top: made.restZ! })) : null;
    }
    if (p.stop !== undefined || p.y !== undefined) {
      const kept = made.spacers.filter((x) => (p.stop === undefined || x.side !== 'X-') && (p.y === undefined || x.side !== 'Y-'));
      s.spacers = [...kept, ...(p.stop ? [{ side: 'X-' as const, mm: p.stop }] : []), ...(p.y ? [{ side: 'Y-' as const, mm: p.y }] : [])];
      if (p.stop !== undefined && made.grip) s.jawX = jawsFrom(made.grip.stop - p.stop);
    }
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [made, preview?.setup, preview?.cale, preview?.stop, preview?.y]);
  const range: [number, number] = sel?.moves ?? [0, Math.max(0, total - 1)];
  const hard = (x: SetupInfo) => x.collisions.filter((c) => c.what !== 'cale' && c.what !== 'spacer');
  const hits = setups.reduce((n, x) => n + hard(x).length, 0);

  // A tool or clamping asked for by the page: there, paused (Play goes on from there).
  useEffect(() => {
    if (!focus) return;
    soloEnd.current = null;
    // From the start, playing (the page's Simulate).
    if (focus.play && focus.tool === undefined) {
      setHeat(false);
      seek(0);
      setPlaying(true);
      return;
    }
    const k = path.moves.findIndex((m) => m.setup === focus.setup && (focus.tool === undefined || m.tool === focus.tool));
    if (k < 0) return;
    // That tool alone: from its first move to the end of its run, then paused there.
    if (focus.play) {
      let e = k;
      while (e + 1 < total && path.moves[e + 1].setup === focus.setup && path.moves[e + 1].tool === focus.tool) e++;
      soloEnd.current = e + 1;
      setHeat(false);
      seek(k);
      setPlaying(true);
      return;
    }
    setPlaying(false);
    setHeat(false);
    seek(k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.key, path]);

  // Runs of one tool in one clamping: the timeline's segments, as long as each runs.
  const runs = useMemo(() => {
    const out: { setup: number; tool: number | null; from: number; to: number; seconds: number }[] = [];
    path.moves.forEach((m, i) => {
      const last = out[out.length - 1];
      if (last && last.setup === m.setup && last.tool === m.tool) {
        last.to = i;
        last.seconds += m.seconds;
      } else out.push({ setup: m.setup, tool: m.tool, from: i, to: i, seconds: m.seconds });
    });
    return out;
  }, [path]);
  // The track is the moves' own time (tool changes are not segments of it).
  const totalSeconds = Math.max(1e-6, runs.reduce((a, r) => a + r.seconds, 0));
  const playOn = () => {
    soloEnd.current = null;
    setHeat(false);
    setPlaying((p) => !p);
  };
  const goRun = (dir: 1 | -1) => {
    soloEnd.current = null;
    setPlaying(false);
    const at = Math.max(0, step - 1);
    const k = runs.findIndex((r) => at >= r.from && at <= r.to);
    const r = runs[Math.min(runs.length - 1, Math.max(0, k + dir))];
    if (r) seek(r.from + 1);
  };
  // A click on the track: that instant.
  const onTrack = (e: React.MouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const s = ((e.clientX - box.left) / box.width) * totalSeconds;
    let k = timeline.findIndex((x) => x >= s);
    if (k < 0) k = total - 1;
    soloEnd.current = null;
    setPlaying(false);
    setHeat(false);
    seek(k + 1);
  };
  const weak = () => {
    const on = !heat;
    setHeat(on);
    if (on) {
      setPlaying(false);
      setJump({ kind: 'end', from: null, key: Date.now() });
      seek(total);
    }
  };

  // Keys in the viewport: Space plays, ← → step, F fits (never while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)))) return;
      if (e.key === ' ' && el?.tagName !== 'BUTTON') {
        e.preventDefault();
        playOn();
      } else if (e.key === 'ArrowRight') seek(Math.min(total, Math.floor(clock.current) + 1));
      else if (e.key === 'ArrowLeft') seek(Math.max(0, Math.ceil(clock.current) - 1));
      else if (e.key === 'f' || e.key === 'F') setFitKey((k) => k + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total]);

  const tool = 'no-glass w-8 h-8 grid place-items-center rounded-[8px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[rgba(var(--ov),0.08)] aria-pressed:bg-[var(--accent-primary)]/20 aria-pressed:text-[var(--text-primary)]';
  const menuItem = 'no-glass w-full flex items-center gap-2 h-8 px-2.5 rounded-[6px] text-[13px] text-left text-[var(--text-primary)] hover:bg-[rgba(var(--ov),0.08)]';
  const seg = (on: boolean) => `no-glass h-7 px-2.5 rounded-[6px] text-[13px] ${on ? 'bg-[rgba(var(--ov),0.12)] text-[var(--text-primary)] font-semibold' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`;
  const cameraName = view3d ? t(`camAi.sim.camera.${view3d.kind}`) : t('camAi.sim.camera.iso');
  const setupNow = sel?.index ?? 0;
  const atSeconds = Math.min(elapsed, totalSeconds);

  return (
    <div ref={shell} className="absolute inset-0 flex flex-col">
      <div className="relative flex-1 min-h-0 bg-[radial-gradient(ellipse_at_50%_40%,#16213A_0%,#0B1222_72%)]">
        <Suspense fallback={null}>
            <Toolpath3D path={path} program={program} setup={sel} range={range} clock={clock} colorOf={colorOf} fitKey={fitKey} onSolid={setSolid} heat={heat} pathsOnly={nx} playing={playing} measure={measure.on} mode={measure.mode} onMeasure={measure.onMeasure} jump={jump} look={look} section={section} view={view3d} seeThrough={false} details={false} behind={behind} model={model} modelView={model ? modelView : 'part'} onModel={(st) => { setModelState(st); onModel?.(st); }} showAll={!selected} onPickTool={onPickTool && ((tl) => onPickTool(sel?.index ?? 0, tl))} />
        </Suspense>

        {/* One floating toolbar. */}
        <div role="toolbar" aria-label={t('camAi.sim.toolbar')} className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 p-1 rounded-[10px] border border-[rgba(255,255,255,0.12)] bg-[#0E1526]/90 backdrop-blur shadow-[0_8px_24px_rgba(0,0,0,0.35)]">
          <button type="button" className={tool} aria-pressed={measure.on} aria-label={t('camAi.sim.measure')} title={`${t('camAi.sim.measure')}  M`} onClick={onMeasureToggle}>
            <Measure size={18} stroke={1.6} />
          </button>
          <button type="button" className={tool} aria-pressed={!!section} aria-label={t('camAi.sim.section')} title={t('camAi.sim.section')} onClick={() => setSection((x) => (x ? null : { axis: 1, at: 0.5 }))}>
            <Slice size={18} stroke={1.6} />
          </button>
          <button type="button" className={tool} aria-pressed={heat} aria-label={t('camAi.sim.weak')} title={t('camAi.sim.weakHelp')} onClick={weak}>
            <Wall size={18} stroke={1.6} />
          </button>
          <span className="w-px h-5 bg-[rgba(255,255,255,0.12)] mx-1" aria-hidden />
          <Popover.Root>
            <Popover.Trigger asChild>
              <button type="button" className="no-glass h-8 px-2.5 inline-flex items-center gap-1.5 rounded-[8px] text-[13px] text-[var(--text-primary)] hover:bg-[rgba(var(--ov),0.08)] disabled:opacity-40">
                <CameraRotate size={16} stroke={1.6} className="text-[var(--text-secondary)]" aria-hidden />
                {cameraName}
                <ChevronDown size={14} className="text-[var(--text-secondary)]" aria-hidden />
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content sideOffset={6} className="cam-pop z-[1000] w-44 p-1">
                {(['top', 'front', 'iso'] as const).map((k) => (
                  <Popover.Close key={k} asChild>
                    <button type="button" className={menuItem} onClick={() => setView3d({ kind: k, key: Date.now() })}>{t(`camAi.sim.camera.${k}`)}</button>
                  </Popover.Close>
                ))}
                <Popover.Close asChild>
                  <button type="button" className={menuItem} onClick={() => setFitKey((k) => k + 1)}>
                    <Fit size={15} stroke={1.6} aria-hidden /> <span className="flex-1">{t('camAi.sim.fit')}</span> <kbd className="font-mono text-xs text-[var(--text-secondary)]">F</kbd>
                  </button>
                </Popover.Close>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          {model && (
            <Popover.Root>
              <Popover.Trigger asChild>
                <button type="button" className="no-glass h-8 px-2.5 inline-flex items-center gap-1.5 rounded-[8px] text-[13px] text-[var(--text-primary)] hover:bg-[rgba(var(--ov),0.08)] disabled:opacity-40">
                  <Eye size={16} stroke={1.6} className="text-[var(--text-secondary)]" aria-hidden />
                  {t(`camAi.sim.show.${modelView}`)}
                  <ChevronDown size={14} className="text-[var(--text-secondary)]" aria-hidden />
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content sideOffset={6} className="cam-pop z-[1000] w-44 p-1">
                  {(['part', 'model', 'both'] as const).map((k) => (
                    <Popover.Close key={k} asChild>
                      <button type="button" className={menuItem} aria-current={modelView === k || undefined} onClick={() => setModelView(k)}>{t(`camAi.sim.show.${k}`)}</button>
                    </Popover.Close>
                  ))}
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          )}
        </div>

        {section && (
          <div className="absolute left-3 top-16 z-10 w-56 rounded-[8px] border border-[rgba(255,255,255,0.12)] bg-[#0E1526]/92 px-3 py-2 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-[var(--text-primary)] flex-1">{t('camAi.sim.section')}</span>
              <div className="inline-flex rounded-[6px] border border-[rgba(255,255,255,0.12)] p-0.5" role="radiogroup" aria-label={t('camAi.sim.sectionAxis')}>
                {([0, 1, 2] as const).map((ax) => (
                  <button key={ax} type="button" role="radio" aria-checked={section.axis === ax} onClick={() => setSection({ ...section, axis: ax })} className={`no-glass w-7 h-6 rounded-[4px] text-xs font-mono ${section.axis === ax ? 'bg-[rgba(var(--ov),0.14)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>
                    {'XYZ'[ax]}
                  </button>
                ))}
              </div>
            </div>
            <input type="range" min={0} max={100} value={Math.round(section.at * 100)} onChange={(e) => setSection({ ...section, at: Number(e.target.value) / 100 })} aria-label={t('camAi.sim.sectionAt')} className="w-full h-5" />
          </div>
        )}

        {/* Only two small corner chips. */}
        <span className="absolute left-3 bottom-3 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-[8px] border border-[#facc15]/30 bg-[#0E1526]/85 text-xs text-[#fde68a]">
          <Parallels size={14} stroke={1.6} aria-hidden /> {parallels(setupNow)}
        </span>
        <span role="status" className={`absolute right-3 bottom-3 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-[8px] border bg-[#0E1526]/85 text-xs ${hits ? 'border-[#f87171]/45 text-[#fca5a5]' : 'border-[#4ade80]/35 text-[#86efac]'}`}>
          {hits ? <ShieldX size={14} stroke={1.6} aria-hidden /> : <ShieldCheck size={14} stroke={1.6} aria-hidden />}
          {hits ? t('camAi.sim.hits', { count: hits }) : t('camAi.sim.noHits')}
        </span>
      </div>

      {/* The timeline: one segment per tool, as long as it runs; the clampings as ticks under it. */}
      <div className="h-[76px] shrink-0 flex items-center gap-3 px-3 border-t border-[var(--border-subtle)] bg-[var(--bg-panel)]">
        <div className="flex items-center gap-1">
          <button type="button" className={tool} aria-label={t('camAi.sim.prevTool')} title={t('camAi.sim.prevTool')} onClick={() => goRun(-1)}>
            <PrevTool size={16} />
          </button>
          <button type="button" onClick={playOn} aria-label={t(playing ? 'camAi.sim.pause' : 'camAi.sim.play')} title={`${t(playing ? 'camAi.sim.pause' : 'camAi.sim.play')}  Space`} className="no-glass w-9 h-9 grid place-items-center rounded-full bg-[var(--accent-primary)] text-white hover:brightness-110">
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <button type="button" className={tool} aria-label={t('camAi.sim.nextTool')} title={t('camAi.sim.nextTool')} onClick={() => goRun(1)}>
            <NextTool size={16} />
          </button>
        </div>
        <div className="relative flex-1 min-w-0 h-11">
          <div className="absolute inset-x-0 top-1.5 h-3.5 flex gap-px rounded-[4px] overflow-hidden cursor-pointer" onClick={onTrack} role="presentation">
            {runs.map((r, i) => {
              const on = !selected || (r.setup === selected.setup && r.tool === selected.tool);
              return <span key={i} title={`${runLabel(r.setup, r.tool)} · ${clockText(r.seconds)}`} className="h-full hover:brightness-125" style={{ width: `${(r.seconds / totalSeconds) * 100}%`, background: colorOf(r.tool), opacity: on ? 1 : 0.45 }} />;
            })}
          </div>
          <span className="absolute top-0 w-0.5 h-[26px] rounded bg-white shadow-[0_0_0_2px_rgba(10,15,28,0.7)] pointer-events-none" style={{ left: `${(atSeconds / totalSeconds) * 100}%` }} aria-hidden />
          {setups.map((s) =>
            s.moves ? (
              <span key={s.index} className="absolute top-6 flex items-center gap-1 text-xs text-[var(--text-secondary)] whitespace-nowrap" style={{ left: `${((s.moves[0] > 0 ? timeline[s.moves[0] - 1] : 0) / totalSeconds) * 100}%` }}>
                <span className="w-px h-2.5 bg-[var(--text-secondary)]" aria-hidden />
                {stepLabel(s.index)}
              </span>
            ) : null,
          )}
          <input
            type="range"
            className="sr-only"
            min={0}
            max={total}
            value={step}
            onChange={(e) => {
              setPlaying(false);
              const n = Number(e.target.value);
              clock.current = n;
              setStep(n);
            }}
            aria-label={t('camAi.sim.position')}
          />
        </div>
        <span className="font-mono text-xs text-[var(--text-secondary)] tabular-nums">{clockText(atSeconds)} / {clockText(totalSeconds)}</span>
        <label className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
          {t('camAi.sim.speed')}
          <select className="aurora-input h-8 py-0 px-2 text-[13px]" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {SPEEDS.map((v, i) => (
              <option key={v} value={i}>{v}×</option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
