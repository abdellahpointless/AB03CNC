import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Box, Check, CheckCircle2, Circle, Cpu, Download, FileCode2, FilePlus2, Loader2, Lock, MousePointerClick, Package, Pencil, Play, RefreshCw, Route, Send, Settings2, Square, Upload } from 'lucide-react';
import { Dialog, Popover } from 'radix-ui';
import { useSync } from '../contexts/SyncContext';
import { useT } from '../i18n';
import { fmtNumber as fmt } from '../i18n/format';
import { api } from '../lib/api';
import { downloadBlob } from '../lib/download';
import { currentRegion } from '../lib/instance';
import { MODEL_MAX_BYTES, type ModelError } from '../lib/modelLimits';
import { speedsFor } from '../lib/toolpath';
import { DEFAULT_LIMITS } from '../lib/cam/limits';
import { convertHaasToFanuc } from '../lib/haasToFanucConverter';
import { engineMachineId } from '../regions';
import { alternatives, CAM_MATERIALS, type CamMaterial } from '../lib/cam/tools';
import { PART_TYPES, type PartType } from '../lib/cam/partType';
import { renderViews } from '../lib/cam/thumbs';
import type { CamMessage, CamRequest, CamSummary, Prepared } from '../lib/cam/cam.worker';
import type { LiveEvent, Purpose } from '../lib/cam/program';
import type { Mat3 } from '../lib/orient';
import { passed, ProgramPanel, SetupPanel, ToolCard, useToolName, useVerdict } from './CamAiResult';
import type { FacePick, LivePath } from './CamPartView';
import type { CutEdit } from '../lib/cam/tools';

const ToolpathViewer = lazy(() => import('./ToolpathViewer'));
const CamPartView = lazy(() => import('./CamPartView'));

/** The automatic raw block: the part plus 4 mm in X and Y and 7 mm in Z (in the vise), centred. */
const AUTO_EXCESS = [4, 4, 7];
/** The side facing the other way ('Z+' -> 'Z-'). */
const opposite = (side: string) => side[0] + (side[1] === '+' ? '-' : '+');
/** What the planner is doing, as it says (cam.worker 'live'). */
type Live = { stages: string[]; setup: number; of: number; sides: string[]; paths: (LivePath & { setup: number })[] };
const NO_LIVE: Live = { stages: [], setup: -1, of: 0, sides: [], paths: [] };

type Model = { name: string; bytes: Uint8Array };
type Run = { state: 'idle' } | { state: 'preparing' } | { state: 'busy'; done: number; of: number } | { state: 'error'; error: ModelError | 'failed' } | { state: 'done'; result: CamSummary };
type Family = 'ALU' | 'POM' | 'FH';

const SIDE_STOCK_KEY = 'cnc-camai-side-stock';
const readSideStock = () => {
  try {
    const v = Number(localStorage.getItem(SIDE_STOCK_KEY));
    return Number.isFinite(v) && v >= 0 && v <= 0.5 ? v : 0;
  } catch {
    return 0;
  }
};

/** Excess given along the vise's X, Y, Z, back on the model's own axes (as layouts.ts: toModelAxes). */
const toModelAxes = (R: Mat3, v: number[]) => [0, 1, 2].map((k) => v[[0, 1, 2].find((j) => R[j * 3 + k] !== 0)!]);

/**
 * CAM AI, step by step: the part's 3D model; its name and type (from the PDF, the operator
 * confirms or changes it); how it lies in the vise (best first, each shown); the raw part (as the
 * part, or the excess left on it); the machine and material (inox asks to use the MS templates, any
 * other material asks for the family to program it with). Then the program, simulated and checked
 * (lib/cam/program.ts); Download and Send only once every check passes (CamAiResult).
 */
export default function CamAi({ onSend }: { onSend: (code: string, fileName: string, machine: string) => void }) {
  const { t } = useT('remapper');
  const { toolbox, toolMachines } = useSync();
  const [model, setModel] = useState<Model | null>(null);
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [views, setViews] = useState<string[]>([]);
  const [partType, setPartType] = useState<PartType | ''>('');
  const [layout, setLayout] = useState(0);
  // Setups, one after the other: setup 1's top face (the layout's side, or a face picked on the
  // model), confirmed; then setup 2's (CAM AI proposes the opposite side), confirmed.
  const [face1, setFace1] = useState<string | undefined>();
  const [locked1, setLocked1] = useState(false);
  const [second, setSecond] = useState<{ side: string; face?: string } | null>(null);
  const [locked2, setLocked2] = useState(false);
  const [pickNote, setPickNote] = useState<'' | 'noFit' | 'same'>('');
  // The raw block: automatic (+4, +4, +7), or typed as totals or as an allowance per side.
  const [autoStock, setAutoStock] = useState(true);
  const [stockMode, setStockMode] = useState<'total' | 'side'>('total');
  const [totals, setTotals] = useState(['', '', '']);
  const [perSide, setPerSide] = useState(['2', '2', '3.5']);
  const [live, setLive] = useState<Live>(NO_LIVE);
  const [cuts, setCuts] = useState<Record<string, CutEdit>>({});
  // Operations the operator removed: in the program already (skip), and marked since (skipDraft, for the next time it is made).
  const [skip, setSkip] = useState<string[]>([]);
  const [skipDraft, setSkipDraft] = useState<string[]>([]);
  const [skipLabels, setSkipLabels] = useState<Record<string, string>>({});
  const pendingSkips = [...new Set([...skip, ...skipDraft])].filter((k) => skip.includes(k) !== skipDraft.includes(k)).length;
  const [machineId, setMachineId] = useState(() => toolMachines[0]?.id ?? '');
  const [material, setMaterial] = useState<CamMaterial | 'INOX' | 'OTHER'>('FH');
  const [family, setFamily] = useState<Family>('ALU');
  const [sideStock, setSideStock] = useState(readSideStock);
  const [swap, setSwap] = useState<{ exclude: string[]; prefer: string[] }>({ exclude: [], prefer: [] });
  const [run, setRun] = useState<Run>({ state: 'idle' });
  const [viewing, setViewing] = useState(false);
  const worker = useRef<Worker | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const machine = toolMachines.find((m) => m.id === machineId) ?? toolMachines[0];
  const tools = machine ? toolbox[machine.id] ?? [] : [];
  const name = model ? model.name.replace(/\.(pdf|stl)$/i, '') : '';
  const fileName = `${name || 'CAM_AI'}.nc`;
  // The material the templates are taken for (inox waits for the operator's yes to MS).
  const templatesFor: CamMaterial | null = material === 'INOX' ? null : material === 'OTHER' ? family : material;
  const busy = run.state === 'busy' || run.state === 'preparing';
  const chosen = prep?.layouts[layout];
  // What is added to the part in the vise's X, Y, Z (centred: half on each side).
  const excess: number[] | null = !chosen
    ? null
    : autoStock
      ? AUTO_EXCESS
      : stockMode === 'total'
        ? totals.map((v, k) => Number(v) - chosen.size[k])
        : perSide.map((v) => 2 * Number(v));
  const excessOk = !!excess && excess.every((v) => Number.isFinite(v) && v >= 0 && v <= 200);
  const raw = prep && chosen && excess && excessOk ? (toModelAxes(chosen.R, excess).map((e, k) => prep.size[k] + e) as [number, number, number]) : null;
  const side2 = second?.side ?? (chosen ? opposite(chosen.side) : '');
  const picking = !prep || busy ? null : !locked1 ? 0 : !locked2 ? 1 : null;
  const picks: FacePick[] = chosen ? [{ side: chosen.side, face: face1, locked: locked1 }, ...(locked1 ? [{ side: side2, face: second?.face, locked: locked2 }] : [])] : [];
  const ready = !!prep && !!partType && !!chosen?.fits && locked1 && locked2 && !!raw && !!machine && tools.length > 0 && !!templatesFor;

  useEffect(() => () => worker.current?.terminate(), []);

  const newWorker = () => {
    worker.current?.terminate();
    const w = new Worker(new URL('../lib/cam/cam.worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    w.onerror = () => {
      w.terminate();
      worker.current = null;
      setRun({ state: 'error', error: 'failed' });
    };
    return w;
  };

  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MODEL_MAX_BYTES) return setRun({ state: 'error', error: 'tooBig' });
    const m = { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
    setModel(m);
    setPrep(null);
    setViews([]);
    setFace1(undefined);
    setLocked1(false);
    setSecond(null);
    setLocked2(false);
    setPickNote('');
    setTotals(['', '', '']);
    setLive(NO_LIVE);
    setCuts({});
    setDraft({});
    setSkip([]);
    setSkipDraft([]);
    setSkipLabels({});
    setSwap({ exclude: [], prefer: [] });
    setRun({ state: 'preparing' });
    // Read in the worker: the model, its name and family from the PDF, the ways it can lie.
    const w = newWorker();
    w.onmessage = (e: MessageEvent<CamMessage>) => {
      const msg = e.data;
      w.terminate();
      worker.current = null;
      if (msg.type === 'error') return setRun({ state: 'error', error: msg.error });
      if (msg.type !== 'prepared') return;
      setPrep(msg);
      setPartType(msg.partType ?? '');
      const first = Math.max(0, msg.layouts.findIndex((l) => l.fits));
      setLayout(first);
      setTotals(msg.layouts[first].size.map((v, k) => String(Math.round((v + AUTO_EXCESS[k]) * 10) / 10)));
      setRun({ state: 'idle' });
      // The pictures after the page has shown the steps (one offscreen renderer, a moment).
      setTimeout(() => setViews(renderViews(msg.tris, msg.layouts.map((l) => l.R), 168, document.documentElement.classList.contains('dark'))), 30);
    };
    w.postMessage({ type: 'prepare', model: { name: m.name, bytes: m.bytes.slice() } });
  };

  const stop = () => {
    worker.current?.terminate();
    worker.current = null;
    setRun({ state: 'idle' });
  };

  const generate = (with_ = swap, edits = cuts, skips = skip) => {
    if (!model || !machine || !ready || !chosen || !templatesFor || !partType) return;
    const w = newWorker();
    const speeds = speedsFor(machine.brand);
    const request: CamRequest = {
      model,
      material: templatesFor,
      tools,
      brand: machine.brand,
      name: name.slice(0, 40),
      raw,
      partType,
      orient: { side: chosen.side, spin: chosen.spin },
      sideStock: sideStock || undefined,
      exclude: with_.exclude,
      prefer: with_.prefer,
      second: second && second.side !== opposite(chosen.side) ? second.side : undefined,
      cuts: edits,
      skip: skips,
      limits: { maxRpm: machine.maxRpm ?? DEFAULT_LIMITS.maxRpm, maxFeed: machine.maxFeed ?? DEFAULT_LIMITS.maxFeed },
      speeds: { rapid: machine.rapid ?? speeds.rapid, toolChange: machine.toolChange ?? speeds.toolChange },
    };
    w.onmessage = (e: MessageEvent<CamMessage>) => {
      const m = e.data;
      if (m.type === 'progress') return setRun({ state: 'busy', done: m.done, of: m.of });
      if (m.type === 'prepared') return;
      if (m.type === 'live') return setLive((l) => liveStep(l, m.e));
      w.terminate();
      worker.current = null;
      if (m.type === 'error') return setRun({ state: 'error', error: m.error });
      setRun({ state: 'done', result: m.result });
      // A part record for the learning records (Admin > Data). Best effort; only programs that
      // passed every check (a failed run would teach the wrong thing).
      if (m.lesson && passed(m.result)) void api('/toolpath/lessons', { body: { kind: 'part', fileName, start: m.result.match, match: m.result.match, data: m.lesson }, timeoutMs: 120_000 }).catch(() => {});
    };
    setRun({ state: 'busy', done: 0, of: 1 });
    setLive(NO_LIVE);
    w.postMessage(request);
  };

  const result = run.state === 'done' ? run.result : null;
  const download = () => {
    if (!result || !machine || !passed(result)) return;
    const fanuc = machine.brand === 'FANUC' && engineMachineId(currentRegion().id, machine) !== 'FANUC-2';
    const code = fanuc ? convertHaasToFanuc(result.code, fileName).fanucCode : result.code;
    downloadBlob(fileName, new Blob([code], { type: 'text/plain' }));
  };
  const saveSideStock = (v: number) => {
    const ok = Number.isFinite(v) ? Math.min(0.5, Math.max(0, v)) : 0;
    setSideStock(ok);
    try {
      localStorage.setItem(SIDE_STOCK_KEY, String(ok));
    } catch {
      /* a convenience: the default works without it */
    }
  };

  // A face clicked on the model: the top of the setup being chosen.
  const pickFace = (side: string, face: string) => {
    if (!prep || !chosen) return;
    setPickNote('');
    if (picking === 0) {
      // The best way to lay it with that side up, keeping the quarter turn when it can.
      const ways = prep.layouts.map((l, i) => ({ l, i })).filter(({ l }) => l.side === side && l.fits);
      if (!ways.length) return setPickNote('noFit');
      const pick = ways.find(({ l }) => l.spin === chosen.spin) ?? ways[0];
      chooseLayout(pick.i, face);
    } else if (picking === 1) {
      if (side === chosen.side) return setPickNote('same');
      setSecond({ side, face });
    }
  };
  const chooseLayout = (i: number, face?: string) => {
    setLayout(i);
    setFace1(face);
    setSecond(null);
    setLocked2(false);
    if (prep) setTotals(prep.layouts[i].size.map((v, k) => String(Math.round((v + AUTO_EXCESS[k]) * 10) / 10)));
  };

  // The browser's selected item, what the properties panel edits.
  const [sel, setSel] = useState<Sel>({ kind: 'part' });
  const [dialog, setDialog] = useState(false);
  // Cutting values typed and not yet in the program: it must be made again before it goes out.
  const [draft, setDraft] = useState<Record<string, CutEdit>>({});
  const changed = Object.keys({ ...draft, ...cuts }).filter((k) => JSON.stringify(draft[k] ?? {}) !== JSON.stringify(cuts[k] ?? {}));
  const toolName = useToolName();
  const verdict = useVerdictOrNull(result, changed.length + pendingSkips);
  const ok = !!verdict?.ok;
  // What still stands before the program can be made (the status bar says it).
  const next = !prep ? 'model' : !partType ? 'partType' : !locked1 ? 'setup1' : !locked2 ? 'setup2' : !raw ? 'stock' : !machine || !tools.length ? 'machine' : !templatesFor ? 'material' : null;
  // A setup picked again after a program was made: that program is no longer the one shown.
  const unlock = (k: 0 | 1) => {
    if (k === 0) {
      setLocked1(false);
      setSecond(null);
    }
    setLocked2(false);
    if (result) setRun({ state: 'idle' });
    setSel({ kind: 'setup', i: k });
  };
  const recalc = () => {
    setCuts(draft);
    setSkip(skipDraft);
    generate(swap, draft, skipDraft);
  };
  // Removing an operation (or keeping it after all): it stays in the browser, struck through, until the program is made again.
  const toggleOp = (o: { key: string; purpose: Purpose; tool: number }, remove: boolean) => {
    setSkipDraft((d) => (remove ? [...new Set([...d, o.key])] : d.filter((k) => k !== o.key)));
    if (remove) setSkipLabels((l) => ({ ...l, [o.key]: `T${o.tool} · ${t(`camAi.purpose.${o.purpose}`)} (${o.key.split('|')[0]})` }));
  };
  // The browser's setups: the two picked ones before a program, the program's after.
  const setupNodes = result ? result.setups.map((s, i) => ({ i, side: s.side })) : chosen ? [{ i: 0, side: chosen.side }, ...(locked1 ? [{ i: 1, side: side2 }] : [])] : [];
  const paths =
    sel.kind === 'tool'
      ? live.paths.filter((p) => p.setup === sel.i && p.tool === sel.code && (!sel.op || p.key === sel.op))
      : sel.kind === 'setup'
        ? live.paths.filter((p) => p.setup === sel.i)
        : live.paths;

  const node = (active: boolean) =>
    `no-glass w-full text-left flex items-center gap-2 px-2 min-h-8 rounded-[6px] text-xs transition-colors ${active ? 'bg-[var(--accent-primary)]/15 text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[rgba(var(--ov),0.06)]'}`;
  const tb = 'no-glass inline-flex items-center gap-1.5 px-2.5 min-h-9 rounded-[6px] text-xs text-[var(--text-primary)] hover:bg-[rgba(var(--ov),0.08)] disabled:opacity-40 disabled:hover:bg-transparent';
  const head = 'section-label px-2 pt-3 pb-1';

  return (
    <div className="cam-ws glass-panel rounded-[var(--radius-lg)] w-full flex flex-col overflow-hidden h-[calc(100vh-12.5rem)] min-h-[640px]">
      <input ref={fileRef} type="file" accept=".pdf,.stl" className="hidden" onChange={(e) => { void pick(e.target.files?.[0]); setDialog(true); e.target.value = ''; }} />

      {/* Toolbar */}
      <header className="flex items-center gap-1 px-2 h-12 shrink-0 border-b border-[var(--border-subtle)]" role="toolbar" aria-label={t('camAi.ws.toolbar')}>
        <span className="flex items-center gap-2 px-2 mr-1">
          <Cpu size={16} className="text-[var(--accent-primary)]" aria-hidden />
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">CAM AI</h2>
          <span className="badge-warning text-[10px] py-0.5 px-1.5">{t('camAi.beta')}</span>
        </span>
        <span className="w-px h-6 bg-[var(--border-subtle)]" aria-hidden />
        <button type="button" className={tb} onClick={() => setDialog(true)} disabled={busy}>
          <FilePlus2 size={15} /> {t('camAi.ws.new')}
        </button>
        <span className="w-px h-6 bg-[var(--border-subtle)]" aria-hidden />
        {run.state === 'busy' ? (
          <button type="button" className={tb} onClick={stop}>
            <Square size={14} /> {t('camAi.stop')}
          </button>
        ) : (
          <button type="button" className={`${tb} font-semibold text-[var(--blue-text)]`} onClick={() => generate()} disabled={!ready || busy}>
            <Play size={15} /> {t(result ? 'camAi.again' : 'camAi.generate')}
          </button>
        )}
        <button type="button" className={tb} onClick={() => setViewing(true)} disabled={!result || busy}>
          <Route size={15} /> {t('camAi.ws.simulate')}
        </button>
        <span className="w-px h-6 bg-[var(--border-subtle)]" aria-hidden />
        <button type="button" className={tb} onClick={download} disabled={!ok || busy} title={ok ? undefined : t('camAi.locked')}>
          <Download size={15} /> {t('camAi.download')}
        </button>
        <button type="button" className={tb} onClick={() => result && ok && machine && onSend(result.code, fileName, machine.id)} disabled={!ok || busy} title={ok ? undefined : t('camAi.locked')}>
          <Send size={15} /> {t('camAi.send')}
        </button>
        <span className="flex-1" />
        <Popover.Root>
          <Popover.Trigger asChild>
            <button type="button" className={tb}>
              <Settings2 size={15} /> {t('camAi.settings')}
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content align="end" sideOffset={6} className="cam-pop z-[1000] w-72 p-3 space-y-1.5">
              <label className="space-y-1 block">
                <span className="section-label block">{t('camAi.sideStock')}</span>
                <input className="aurora-input w-full text-xs" type="number" min={0} max={0.5} step={0.01} inputMode="decimal" value={sideStock} onChange={(e) => saveSideStock(Number(e.target.value))} />
              </label>
              <p className="text-xs text-[var(--text-tertiary)]">{t('camAi.sideStockHint')}</p>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </header>

      <div className="flex-1 min-h-0 grid grid-cols-[15rem_minmax(0,1fr)_21rem]">
        {/* Browser */}
        <nav className="border-r border-[var(--border-subtle)] overflow-y-auto p-1.5" aria-label={t('camAi.ws.browser')}>
          {prep ? (
            <ul className="space-y-0.5">
              <li>
                <button type="button" className={node(sel.kind === 'part')} aria-current={sel.kind === 'part' || undefined} onClick={() => setSel({ kind: 'part' })}>
                  <Box size={14} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden />
                  <span className="truncate flex-1">{prep.title ?? name}</span>
                  {!partType && <AlertTriangle size={13} className="text-[var(--orange-text)]" aria-label={t('camAi.ws.needs')} />}
                </button>
              </li>
              <li>
                <button type="button" className={node(sel.kind === 'stock')} aria-current={sel.kind === 'stock' || undefined} onClick={() => setSel({ kind: 'stock' })}>
                  <Package size={14} className="shrink-0 text-[#f5a524]" aria-hidden />
                  <span className="truncate flex-1">{t('camAi.ws.stock')}</span>
                  {chosen && excess && <span className="tabular-nums text-[10px] text-[var(--text-tertiary)]">{[0, 1, 2].map((k) => fmt(chosen.size[k] + excess[k], 1)).join('×')}</span>}
                </button>
              </li>
              <li className={head}>{t('camAi.ws.setups')}</li>
              {setupNodes.map(({ i, side }) => {
                const done = i === 0 ? locked1 : i === 1 ? locked2 : true;
                const s = result?.setups[i];
                const byTool = s ? [...new Map(s.ops.map((o) => [o.code, o] as const)).values()] : [];
                const issue = s && (!s.physics.ok || s.ops.some((o) => o.unsafe));
                return (
                  <li key={i}>
                    <button type="button" className={node(sel.kind === 'setup' && sel.i === i)} aria-current={(sel.kind === 'setup' && sel.i === i) || undefined} onClick={() => setSel({ kind: 'setup', i })}>
                      {issue ? <AlertTriangle size={14} className="shrink-0 text-[var(--orange-text)]" aria-hidden /> : done ? <CheckCircle2 size={14} className="shrink-0 text-[var(--green-text,#1fb257)]" aria-hidden /> : <span className="w-3.5 h-3.5 shrink-0 grid place-items-center" aria-hidden><span className="w-2 h-2 rounded-full bg-[var(--accent-primary)]" /></span>}
                      <span className="flex-1 truncate">{t('camAi.setupStep', { n: i + 1, op: (i + 1) * 10 })}</span>
                      <span className="font-mono text-[11px]">{side}</span>
                      <span className="sr-only">{t(issue ? 'camAi.setupIssue' : done ? 'camAi.stepState.done' : 'camAi.stepState.now')}</span>
                    </button>
                    {byTool.length > 0 && (
                      <ul className="ml-4 pl-2 border-l border-[var(--border-subtle)] space-y-0.5 my-0.5">
                        {byTool.map((o) => (
                          <li key={o.code}>
                            <button type="button" className={node(sel.kind === 'tool' && sel.i === i && sel.code === o.code)} aria-current={(sel.kind === 'tool' && sel.i === i && sel.code === o.code) || undefined} onClick={() => setSel({ kind: 'tool', i, code: o.code })}>
                              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: PURPOSE_HEX[o.purpose] }} aria-hidden />
                              <span className="font-mono text-[11px] shrink-0">T{o.tool}</span>
                              <span className="truncate flex-1">{toolName(o)}</span>
                              {(changed.includes(o.code) || o.unsafe) && <AlertTriangle size={12} className="shrink-0 text-[var(--orange-text)]" aria-label={t('camAi.changedBadge')} />}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
              {!result && locked1 && locked2 && <li className="px-2 py-1 text-[11px] text-[var(--text-tertiary)]">{t('camAi.restByAi')}</li>}
              {!result && !locked1 && (
                <li className="flex items-center gap-2 px-2 min-h-8 text-xs text-[var(--text-tertiary)]">
                  <Lock size={13} aria-hidden /> {t('camAi.setupStep', { n: 2, op: 20 })}
                  <span className="sr-only">{t('camAi.stepState.locked')}</span>
                </li>
              )}
              {result && (
                <>
                  <li className={head}>{t('camAi.ws.output')}</li>
                  <li>
                    <button type="button" className={node(sel.kind === 'program')} aria-current={sel.kind === 'program' || undefined} onClick={() => setSel({ kind: 'program' })}>
                      <FileCode2 size={14} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden />
                      <span className="flex-1 truncate">{fileName}</span>
                      {ok ? <CheckCircle2 size={13} className="text-[var(--green-text,#1fb257)]" aria-hidden /> : <AlertTriangle size={13} className="text-[var(--orange-text)]" aria-hidden />}
                    </button>
                  </li>
                </>
              )}
            </ul>
          ) : (
            <p className="text-xs text-[var(--text-tertiary)] p-2">{t('camAi.ws.empty')}</p>
          )}
        </nav>

        {/* Viewport */}
        <main className="relative min-w-0 bg-[rgba(var(--ov),0.025)]" aria-label={t('camAi.ws.viewport')}>
          {prep && chosen ? (
            <div className="absolute inset-0">
            <Suspense fallback={null}>
              <CamPartView
                tris={prep.tris}
                R={chosen.R}
                raw={raw}
                picks={result || busy ? [] : picks}
                picking={result ? null : picking}
                onPick={pickFace}
                paths={paths}
                label={picking !== null && !result ? t('camAi.view3d') : t('camAi.live.view')}
                className="h-full rounded-none bg-transparent"
              />
            </Suspense>
            </div>
          ) : (
            <div className="absolute inset-0 grid place-items-center p-6">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); void pick(e.dataTransfer.files?.[0]); setDialog(true); }}
                disabled={busy}
                className="no-glass w-full max-w-md aspect-[16/9] border-2 border-dashed border-[var(--border-subtle)] hover:border-[var(--blue-500)]/60 rounded-[var(--radius-lg)] flex flex-col items-center justify-center gap-2 text-xs text-[var(--text-secondary)] transition-colors"
              >
                <Upload size={22} className="text-[var(--blue-text)]" />
                <span className="text-sm font-medium text-[var(--text-primary)]">{run.state === 'preparing' ? t('camAi.reading') : t('camAi.drop')}</span>
                <span className="text-[var(--text-tertiary)]">{t('camAi.dropHint')}</span>
              </button>
            </div>
          )}
          {/* What the view is doing, top centre. */}
          {prep && !result && picking !== null && (
            <p className="absolute top-3 left-1/2 -translate-x-1/2 max-w-[90%] flex items-center gap-2 rounded-full px-3 py-1.5 text-xs bg-[var(--bg-panel)]/90 backdrop-blur border border-[var(--border-subtle)] text-[var(--text-primary)] shadow">
              <MousePointerClick size={14} className="text-[var(--blue-text)] shrink-0" aria-hidden />
              {t('camAi.pickHint', { n: picking + 1 })}
            </p>
          )}
          {pickNote && <p role="alert" className="absolute top-14 left-1/2 -translate-x-1/2 rounded-full px-3 py-1.5 text-xs bg-[var(--bg-panel)]/95 border border-[#f5b942]/50 text-[var(--orange-text)]">{t(`camAi.pickNote.${pickNote}`)}</p>}
          {run.state === 'busy' && (
            <div className="absolute left-3 bottom-3 w-[19rem] max-w-[calc(100%-1.5rem)]">
              <LiveConsole live={live} done={!!result} excess={excess ?? AUTO_EXCESS} />
            </div>
          )}
          {prep && (
            <p className="absolute right-3 top-3 flex flex-col gap-1 rounded-[var(--radius-md)] px-2.5 py-2 text-[11px] bg-[var(--bg-panel)]/85 backdrop-blur border border-[var(--border-subtle)] text-[var(--text-secondary)]" aria-hidden>
              <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-[#2f80ff]/60 mr-1.5 align-middle" />{t('camAi.legend.hover')}</span>
              <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-[#22c55e] mr-1.5 align-middle" />{t('camAi.legend.top')}</span>
              <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-[#f5a524] mr-1.5 align-middle" />{t('camAi.legend.stock')}</span>
            </p>
          )}
        </main>

        {/* Properties */}
        <aside className="border-l border-[var(--border-subtle)] overflow-y-auto" aria-labelledby="cam-props">
          <h3 id="cam-props" className="text-xs font-semibold text-[var(--text-primary)] px-3 h-10 flex items-center border-b border-[var(--border-subtle)] sticky top-0 bg-[var(--bg-panel)]/95 backdrop-blur z-10">
            {sel.kind === 'part' ? t('camAi.ws.partProps') : sel.kind === 'stock' ? t('camAi.ws.stock') : sel.kind === 'program' ? fileName : sel.kind === 'setup' ? t('camAi.setupStep', { n: sel.i + 1, op: (sel.i + 1) * 10 }) : t('camAi.ws.toolProps')}
          </h3>
          <div className="p-3 space-y-3 text-xs">
            {!prep && <p className="text-[var(--text-tertiary)]">{t('camAi.ws.empty')}</p>}

            {prep && sel.kind === 'part' && (
              <>
                {prep.title ? (
                  <dl className="space-y-1">
                    <div><dt className="inline text-[var(--text-tertiary)]">{t('camAi.part.title')}: </dt><dd className="inline font-medium text-[var(--text-primary)]">{prep.title}</dd></div>
                    {prep.sap && <div><dt className="inline text-[var(--text-tertiary)]">{t('camAi.part.sap')}: </dt><dd className="inline font-mono text-[var(--text-primary)]">{prep.sap}</dd></div>}
                  </dl>
                ) : (
                  <p className="text-[var(--orange-text)]">{t('camAi.part.noTitle')}</p>
                )}
                {partFields()}
              </>
            )}

            {prep && chosen && sel.kind === 'stock' && (
              <>
                <button type="button" role="switch" aria-checked={autoStock} onClick={() => setAutoStock(!autoStock)} disabled={busy} className="no-glass flex items-center gap-2 text-xs text-[var(--text-primary)] min-h-11">
                  <span className={`relative w-9 h-5 rounded-full transition-colors ${autoStock ? 'bg-[var(--accent-primary)]' : 'bg-[rgba(var(--ov),0.22)]'}`} aria-hidden>
                    <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${autoStock ? 'translate-x-4' : ''}`} />
                  </span>
                  {t('camAi.stock.auto')}
                </button>
                {!autoStock && (
                  <fieldset className="space-y-2" disabled={busy}>
                    <legend className="sr-only">{t('camAi.stock.manual')}</legend>
                    <div className="inline-flex rounded-[var(--radius-md)] border border-[var(--border-subtle)] p-0.5" role="radiogroup" aria-label={t('camAi.stock.manual')}>
                      {(['total', 'side'] as const).map((m) => (
                        <button key={m} type="button" role="radio" aria-checked={stockMode === m} onClick={() => setStockMode(m)} className={`no-glass text-xs px-3 min-h-9 rounded-[calc(var(--radius-md)-2px)] ${stockMode === m ? 'bg-[var(--accent-primary)]/15 text-[var(--text-primary)] font-medium' : 'text-[var(--text-secondary)]'}`}>
                          {t(`camAi.stock.${m}`)}
                        </button>
                      ))}
                    </div>
                    {(['X', 'Y', 'Z'] as const).map((axis, k) => {
                      const list = stockMode === 'total' ? totals : perSide;
                      const set = stockMode === 'total' ? setTotals : setPerSide;
                      return (
                        <label key={axis} className="grid grid-cols-[1fr_7rem] items-center gap-2">
                          <span className="text-[var(--text-secondary)]">{t(stockMode === 'total' ? 'camAi.stock.totalAxis' : 'camAi.stock.sideAxis', { axis })}</span>
                          <input className="aurora-input w-full min-w-0 text-xs px-2 tabular-nums" type="number" min={0} step={0.5} inputMode="decimal" value={list[k]} onChange={(e) => set(list.map((v, i) => (i === k ? e.target.value : v)))} />
                        </label>
                      );
                    })}
                    {!excessOk && <p className="text-[var(--orange-text)]" role="alert">{t('camAi.stock.tooSmall')}</p>}
                  </fieldset>
                )}
                {raw && excess && (
                  <dl className="grid grid-cols-3 gap-2">
                    {(['X', 'Y', 'Z'] as const).map((axis, k) => (
                      <div key={axis} className="rounded-[var(--radius-md)] border border-[#f5a524]/40 px-2 py-1.5">
                        <dt className="text-[11px] text-[var(--text-tertiary)]">{axis}</dt>
                        <dd className="font-semibold tabular-nums text-[var(--text-primary)]">{fmt(chosen.size[k] + excess[k], 1)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {excess && <p className="text-[var(--text-tertiary)]">{t('camAi.stock.added', { x: fmt(excess[0], 1), y: fmt(excess[1], 1), z: fmt(excess[2], 1) })}</p>}
              </>
            )}

            {prep && chosen && sel.kind === 'setup' && (
              <>
                {sel.i < 2 && !result && (
                  <>
                    {((sel.i === 0 && !locked1) || (sel.i === 1 && locked1 && !locked2)) && <p className="flex gap-2 text-[var(--text-primary)]"><MousePointerClick size={15} className="shrink-0 text-[var(--blue-text)]" aria-hidden />{t('camAi.pickHint', { n: sel.i + 1 })}</p>}
                    <dl className="space-y-1 text-[var(--text-secondary)]">
                      <div className="flex justify-between gap-2"><dt>{t('camAi.ws.top')}</dt><dd className="text-[var(--text-primary)] text-right"><span className="font-mono">{sel.i === 0 ? chosen.side : side2}</span>{sel.i === 0 && chosen.spin ? ` · ${t('camAi.layout.turned')}` : sel.i === 1 && !second ? ` · ${t('camAi.proposed')}` : ''}</dd></div>
                      {sel.i === 0 && <div className="flex justify-between gap-2"><dt>{t('camAi.ws.inVise')}</dt><dd className="tabular-nums text-[var(--text-primary)]">{t('camAi.layout.size', { x: fmt(chosen.size[0], 1), y: fmt(chosen.size[1], 1), z: fmt(chosen.size[2], 1) })}</dd></div>}
                    </dl>
                    <div className="flex flex-wrap gap-2">
                      {sel.i === 0 && !locked1 && (
                        <button type="button" onClick={() => { setLocked1(true); setSel({ kind: 'setup', i: 1 }); }} disabled={!chosen.fits} className="btn-primary text-xs min-h-11 px-4 flex items-center gap-1.5">
                          <Check size={14} /> {t('camAi.confirmSetup', { n: 1 })}
                        </button>
                      )}
                      {sel.i === 1 && locked1 && !locked2 && (
                        <>
                          <button type="button" onClick={() => { setLocked2(true); setSel({ kind: 'stock' }); }} className="btn-primary text-xs min-h-11 px-4 flex items-center gap-1.5">
                            <Check size={14} /> {t('camAi.confirmSetup', { n: 2 })}
                          </button>
                          {second && <button type="button" onClick={() => setSecond(null)} className="btn-secondary text-xs min-h-11 px-3">{t('camAi.useProposal')}</button>}
                        </>
                      )}
                      {((sel.i === 0 && locked1) || (sel.i === 1 && locked2)) && !busy && (
                        <button type="button" onClick={() => unlock(sel.i as 0 | 1)} className="btn-secondary text-xs min-h-11 px-3 flex items-center gap-1.5">
                          <Pencil size={13} /> {t('camAi.changeSetup', { n: sel.i + 1 })}
                        </button>
                      )}
                    </div>
                    {sel.i === 0 && !locked1 && (
                      <details>
                        <summary className="cursor-pointer min-h-9 flex items-center text-[var(--text-secondary)]">{t('camAi.layout.others')}</summary>
                        <fieldset className="grid grid-cols-3 gap-1.5 mt-1" disabled={busy}>
                          <legend className="sr-only">{t('camAi.layout.others')}</legend>
                          {prep.layouts.map((l, i) => (
                            <label key={i} title={`${t('camAi.layout.up', { side: l.side })}${l.spin ? `, ${t('camAi.layout.turned')}` : ''}`} className={`relative rounded-[6px] border p-1 cursor-pointer ${layout === i ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/8' : 'border-[var(--border-subtle)]'} ${l.fits ? '' : 'opacity-40 cursor-not-allowed'}`}>
                              <input type="radio" name="cam-layout" className="sr-only" checked={layout === i} disabled={!l.fits} onChange={() => chooseLayout(i)} aria-label={`${t('camAi.layout.up', { side: l.side })}${l.spin ? `, ${t('camAi.layout.turned')}` : ''}`} />
                              {views[i] ? <img src={views[i]} alt="" className="w-full aspect-square object-contain" /> : <div className="w-full aspect-square" aria-hidden />}
                              <span className="block text-center font-mono text-[10px] text-[var(--text-secondary)]">{l.side}{l.spin ? ' ⟲' : ''}</span>
                            </label>
                          ))}
                        </fieldset>
                      </details>
                    )}
                  </>
                )}
                {result?.setups[sel.i] && <SetupPanel setup={result.setups[sel.i]} />}
              </>
            )}

            {result && sel.kind === 'tool' && (() => {
              const s = result.setups[sel.i];
              const ops = s?.ops.filter((o) => o.code === sel.code) ?? [];
              if (!ops.length || !machine || !templatesFor) return null;
              return (
                <ul aria-label={t('camAi.ops')}>
                  <ToolCard
                    ops={ops}
                    name={toolName(ops[0])}
                    draft={draft[sel.code] ?? {}}
                    changed={changed.includes(sel.code)}
                    busy={busy}
                    onEdit={(v) => setDraft((d) => ({ ...d, [sel.code]: { ...d[sel.code], ...v } }))}
                    removing={skipDraft}
                    onRemove={toggleOp}
                    focus={sel.op ?? null}
                    onFocus={(op) => setSel({ kind: 'tool', i: sel.i, code: sel.code, op: op ?? undefined })}
                    options={alternatives(templatesFor, tools, sel.code, swap.exclude)}
                    toolName={toolName}
                    onSwap={(code, standIn) => {
                      const nextSwap = { exclude: [...swap.exclude, code], prefer: [...swap.prefer, standIn] };
                      setSwap(nextSwap);
                      generate(nextSwap);
                    }}
                  />
                  <li className="pt-2 text-[11px] text-[var(--text-tertiary)] list-none">{t('camAi.everywhere')}</li>
                </ul>
              );
            })()}

            {result && sel.kind === 'program' && machine && (
              <ProgramPanel
                result={result}
                machineName={machine.name}
                changed={changed.length + pendingSkips}
                removed={skipDraft.map((k) => ({ key: k, label: skipLabels[k] ?? k }))}
                onRestore={(k) => setSkipDraft((d) => d.filter((x) => x !== k))}
              />
            )}

            {run.state === 'error' && (
              <p className="badge-danger text-xs py-1.5 px-3" role="alert">
                {run.error === 'failed' ? t('camAi.failed') : t(`toolpath.model.errors.${run.error}`)}
              </p>
            )}
          </div>
        </aside>
      </div>

      {/* Values typed and not in the program yet. */}
      {(changed.length > 0 || pendingSkips > 0) && (
        <div className="flex items-center gap-3 px-3 py-2 border-t border-[var(--accent-primary)]/40 bg-[var(--accent-primary)]/8" role="status">
          <span className="text-xs text-[var(--text-primary)] flex-1 space-y-0.5">
            {changed.length > 0 && <span className="block">{t('camAi.recalcNeeded', { count: changed.length })}</span>}
            {pendingSkips > 0 && <span className="block">{t('camAi.removeNeeded', { count: pendingSkips })}</span>}
          </span>
          <button type="button" onClick={() => { setDraft(cuts); setSkipDraft(skip); }} disabled={busy} className="btn-secondary text-xs min-h-9 px-3">{t('camAi.discard')}</button>
          <button type="button" onClick={recalc} disabled={busy} className="btn-primary text-xs min-h-9 px-4 flex items-center gap-1.5">
            <RefreshCw size={14} className={busy ? 'animate-spin motion-reduce:animate-none' : ''} /> {t('camAi.recalc')}
          </button>
        </div>
      )}

      {/* Status bar */}
      <footer className="flex items-center gap-4 px-3 h-8 shrink-0 border-t border-[var(--border-subtle)] text-[11px] text-[var(--text-secondary)]" role="status" aria-live="polite">
        {run.state === 'busy' ? (
          <span className="flex items-center gap-1.5 text-[var(--blue-text)]"><Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden />{t('camAi.making')}</span>
        ) : verdict ? (
          <span className={`flex items-center gap-1.5 min-w-0 ${verdict.ok ? 'text-[var(--green-text,#1fb257)]' : 'text-[var(--orange-text)]'}`}>
            {verdict.ok ? <CheckCircle2 size={12} aria-hidden /> : <AlertTriangle size={12} aria-hidden />}
            <span className="truncate">{verdict.text}</span>
          </span>
        ) : next ? (
          <span className="truncate">{t(`camAi.ws.next.${next}`)}</span>
        ) : (
          <span className="text-[var(--green-text,#1fb257)]">{t('camAi.ws.ready')}</span>
        )}
        <span className="flex-1" />
        {result && (
          <>
            <span className="tabular-nums">{t('camAi.match')} {t('camAi.percent', { v: fmt(result.match * 100, 2) })}</span>
            <span className="tabular-nums">{t('camAi.minutes', { v: fmt(result.minutes, 1) })}</span>
            <span className="tabular-nums">{t('camAi.toolChanges')} {result.toolChanges}</span>
          </>
        )}
        {machine && <span>{machine.name} · {templatesFor ?? material}</span>}
      </footer>

      {newProgramDialog()}

      {viewing && result && model && (
        <Suspense fallback={null}>
          <ToolpathViewer code={result.code} title={fileName} brand={machine?.brand} onClose={() => setViewing(false)} initialModel={model} noRecord />
        </Suspense>
      )}
    </div>
  );

  /** Part type, machine and material: in the New program dialog and the Part's properties. */
  function partFields() {
    return (
      <div className="space-y-3">
        <label className="block space-y-1">
          <span className="section-label block">{t('camAi.part.type')}</span>
          <select className="aurora-input w-full text-xs cursor-pointer" value={partType} onChange={(e) => setPartType(e.target.value as PartType)} disabled={busy}>
            <option value="" disabled className="bg-[var(--bg-panel)]">{t('camAi.part.choose')}</option>
            {PART_TYPES.map((p) => (
              <option key={p} value={p} className="bg-[var(--bg-panel)]">{t(`camAi.part.types.${p}`)}</option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="section-label block">{t('camAi.machine')}</span>
          <select className="aurora-input w-full text-xs cursor-pointer" value={machine?.id ?? ''} onChange={(e) => setMachineId(e.target.value)} disabled={busy}>
            {toolMachines.map((m) => (
              <option key={m.id} value={m.id} className="bg-[var(--bg-panel)]">{t('controls.machineOption', { name: m.name, count: (toolbox[m.id] || []).length })}</option>
            ))}
          </select>
        </label>
        {!tools.length && machine && <p className="text-[var(--orange-text)]">{t('camAi.noTools', { name: machine.name })}</p>}
        <label className="block space-y-1">
          <span className="section-label block">{t('camAi.material')}</span>
          <select className="aurora-input w-full text-xs cursor-pointer" value={material} onChange={(e) => setMaterial(e.target.value as CamMaterial | 'INOX' | 'OTHER')} disabled={busy}>
            {CAM_MATERIALS.map((m) => (
              <option key={m} value={m} className="bg-[var(--bg-panel)]">{m}</option>
            ))}
            <option value="INOX" className="bg-[var(--bg-panel)]">{t('camAi.inox')}</option>
            <option value="OTHER" className="bg-[var(--bg-panel)]">{t('camAi.otherMaterial')}</option>
          </select>
        </label>
        {material === 'INOX' && (
          <div className="space-y-2 rounded-[var(--radius-md)] border border-[#f5b942]/40 bg-[#f5b942]/8 p-2.5" role="alert">
            <p className="text-[var(--text-primary)]">{t('camAi.inoxAsk')}</p>
            <button type="button" onClick={() => setMaterial('MS')} className="btn-primary text-xs min-h-9 px-3">{t('camAi.useMs')}</button>
          </div>
        )}
        {material === 'OTHER' && (
          <label className="block space-y-1">
            <span className="section-label block">{t('camAi.family')}</span>
            <select className="aurora-input w-full text-xs cursor-pointer" value={family} onChange={(e) => setFamily(e.target.value as Family)} disabled={busy}>
              {(['ALU', 'POM', 'FH'] as const).map((f) => (
                <option key={f} value={f} className="bg-[var(--bg-panel)]">{t(`camAi.families.${f}`)}</option>
              ))}
            </select>
          </label>
        )}
        <p className="text-[11px] text-[var(--text-tertiary)]">{t('camAi.part.typeHint')}</p>
      </div>
    );
  }

  /** New program: the model, then what the part is and where it is made. */
  function newProgramDialog() {
    return (
      <Dialog.Root open={dialog} onOpenChange={setDialog}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[1000] bg-black/45 backdrop-blur-[2px]" />
          <Dialog.Content className="glass-modal fixed z-[1001] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[30rem] max-w-[calc(100vw-2rem)] max-h-[90vh] overflow-y-auto p-5 space-y-4">
            <Dialog.Title className="text-sm font-semibold text-[var(--text-primary)]">{t('camAi.ws.newTitle')}</Dialog.Title>
            <Dialog.Description className="text-xs text-[var(--text-secondary)]">{t('camAi.intro')}</Dialog.Description>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); void pick(e.dataTransfer.files?.[0]); }}
              disabled={busy}
              className="no-glass w-full h-24 border-2 border-dashed border-[var(--border-subtle)] hover:border-[var(--blue-500)]/60 rounded-[var(--radius-md)] flex flex-col items-center justify-center gap-1 text-xs text-[var(--text-secondary)]"
            >
              <Upload size={18} className="text-[var(--blue-text)]" />
              <span className="font-medium text-[var(--text-primary)]">{run.state === 'preparing' ? t('camAi.reading') : model ? model.name : t('camAi.drop')}</span>
              <span className="text-[var(--text-tertiary)]">{model ? `${fmt(model.bytes.length / 1048576, 1)} MB · ${t('camAi.change')}` : t('camAi.dropHint')}</span>
            </button>
            {prep && (
              <>
                {prep.title && <p className="text-xs"><span className="text-[var(--text-tertiary)]">{t('camAi.part.title')}: </span><span className="font-medium text-[var(--text-primary)]">{prep.title}</span></p>}
                {partFields()}
              </>
            )}
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <button type="button" className="btn-secondary text-xs min-h-11 px-4">{t('camAi.cancel')}</button>
              </Dialog.Close>
              <button
                type="button"
                disabled={!prep || !partType || busy}
                onClick={() => {
                  setDialog(false);
                  setSel({ kind: 'setup', i: 0 });
                }}
                className="btn-primary text-xs min-h-11 px-4"
              >
                {t('camAi.ws.create')}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }
}

type Sel = { kind: 'part' } | { kind: 'stock' } | { kind: 'program' } | { kind: 'setup'; i: number } | { kind: 'tool'; i: number; code: string; op?: string };

/** The paths' colours, for the browser's dots (CamPartView draws them the same). */
const PURPOSE_HEX: Record<string, string> = { face: '#facc15', rough: '#facc15', rest: '#facc15', finish: '#22d3ee', contour: '#22d3ee', thinWalls: '#22d3ee', chamfer: '#22d3ee', engrave: '#22d3ee', centre: '#ef4444', drill: '#ef4444', pinHoles: '#ef4444' };

/** The verdict, once there is a program. */
function useVerdictOrNull(result: CamSummary | null, changed: number) {
  const empty: CamSummary = { code: '', match: 0, minutes: 0, toolChanges: 0, collisions: 0, cales: 0, gouge: 0, size: [], raw: [], missing: [], notes: [], nests: [], setups: [] };
  const v = useVerdict(result ?? empty, changed);
  return result ? v : null;
}

/** One step of the planner into what the page shows (cam.worker 'live'). */
function liveStep(l: Live, e: LiveEvent): Live {
  if (e.kind === 'reset') return NO_LIVE;
  if (e.kind === 'path') return { ...l, paths: [...l.paths, { setup: e.setup, purpose: e.purpose, pts: e.pts, key: e.key, tool: e.tool }] };
  const sides = [...l.sides];
  if (e.stage === 'setup' && e.setup !== undefined && e.side) sides[e.setup] = e.side;
  return { ...l, stages: [...l.stages, e.stage], setup: e.stage === 'setup' ? (e.setup ?? l.setup) : l.setup, of: Math.max(l.of, e.of ?? 0), sides };
}

/** The planner's steps as they happen: done, now (with how far along all of it is), still to come. */
function LiveConsole({ live, done, excess }: { live: Live; done: boolean; excess: number[] }) {
  const { t } = useT('remapper');
  const has = (s: string) => done || live.stages.includes(s);
  const setups = Math.max(live.of, live.setup + 1, 1);
  type Row = { key: string; text: string; state: 'done' | 'now' | 'next' };
  const rows: Row[] = [
    { key: 'features', text: t('camAi.live.features'), state: has('features') ? 'done' : 'now' },
    { key: 'stock', text: t('camAi.live.stock', { x: fmt(excess[0], 1), y: fmt(excess[1], 1), z: fmt(excess[2], 1) }), state: has('stock') ? 'done' : has('features') ? 'now' : 'next' },
    ...Array.from({ length: setups }, (_, k): Row => ({
      key: `setup${k}`,
      text: t('camAi.live.setup', { n: k + 1, op: (k + 1) * 10, side: live.sides[k] ?? '…', count: live.paths.filter((p) => p.setup === k).length }),
      state: has('check') || k < live.setup ? 'done' : k === live.setup ? 'now' : 'next',
    })),
    { key: 'check', text: t('camAi.live.check'), state: has('post') ? 'done' : has('check') ? 'now' : 'next' },
    { key: 'post', text: t('camAi.live.post'), state: done ? 'done' : live.stages.includes('post') ? 'now' : 'next' },
  ];
  const share = Math.round((rows.filter((r) => r.state === 'done').length / rows.length) * 100);
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[rgba(var(--ov),0.03)] p-3 space-y-3" role="status" aria-live="polite" aria-label={t('camAi.live.title')}>
      <div className="flex items-center justify-between text-xs">
        <span className="font-semibold text-[var(--text-primary)]">{t('camAi.live.title')}</span>
        <span className="tabular-nums text-[var(--text-secondary)]">{share} %</span>
      </div>
      <div className="h-1 rounded-full bg-[rgba(var(--ov),0.08)] overflow-hidden" aria-hidden>
        <div className="h-full bg-[var(--accent-primary)] transition-[width] duration-500" style={{ width: `${Math.max(4, share)}%` }} />
      </div>
      <ol className="space-y-2">
        {rows.map((r) => (
          <li key={r.key} className={`flex items-start gap-2 text-xs ${r.state === 'next' ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]'}`}>
            {r.state === 'done' ? (
              <CheckCircle2 size={14} className="shrink-0 mt-px text-[var(--green-text,#1fb257)]" aria-hidden />
            ) : r.state === 'now' ? (
              <Loader2 size={14} className="shrink-0 mt-px text-[var(--blue-text)] animate-spin motion-reduce:animate-none" aria-hidden />
            ) : (
              <Circle size={14} className="shrink-0 mt-px" aria-hidden />
            )}
            <span className="flex-1">{r.text}</span>
            <span className={`shrink-0 text-[10px] font-medium uppercase tracking-wide ${r.state === 'done' ? 'text-[var(--green-text,#1fb257)]' : r.state === 'now' ? 'text-[var(--blue-text)]' : ''}`}>{t(`camAi.live.state.${r.state}`)}</span>
          </li>
        ))}
      </ol>
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[var(--text-secondary)]">
        <span><span className="inline-block w-3 h-0.5 align-middle bg-[#facc15] mr-1" aria-hidden />{t('camAi.live.rough')}</span>
        <span><span className="inline-block w-3 h-0.5 align-middle bg-[#22d3ee] mr-1" aria-hidden />{t('camAi.live.finish')}</span>
        <span><span className="inline-block w-3 h-0.5 align-middle bg-[#ef4444] mr-1" aria-hidden />{t('camAi.live.drill')}</span>
      </p>
    </div>
  );
}
