import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, Circle, Cpu, Loader2, Lock, MousePointerClick, Pencil, Settings2, Square, Upload } from 'lucide-react';
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
import { CAM_MATERIALS, type CamMaterial } from '../lib/cam/tools';
import { PART_TYPES, type PartType } from '../lib/cam/partType';
import { renderViews } from '../lib/cam/thumbs';
import type { CamMessage, CamRequest, CamSummary, Prepared } from '../lib/cam/cam.worker';
import type { LiveEvent } from '../lib/cam/program';
import type { Mat3 } from '../lib/orient';
import CamAiResult, { passed } from './CamAiResult';
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

  const generate = (with_ = swap, edits = cuts) => {
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

  const step = 'glass-panel rounded-[var(--radius-lg)] p-5 space-y-3';
  const h3 = 'text-sm font-semibold text-[var(--text-primary)]';

  return (
    <div className="max-w-5xl mx-auto w-full space-y-4 pb-16">
      <section className={`${step} space-y-5`} aria-labelledby="cam-title">
        <header className="flex items-start gap-3">
          <span className="w-10 h-10 shrink-0 rounded-[var(--radius-md)] bg-[var(--accent-primary)]/12 text-[var(--accent-primary)] flex items-center justify-center">
            <Cpu size={20} />
          </span>
          <div className="space-y-1 flex-1">
            <h2 id="cam-title" className="text-base font-semibold text-[var(--text-primary)] flex items-center gap-2">
              CAM AI <span className="badge-warning text-[10px] py-0.5 px-1.5">{t('camAi.beta')}</span>
            </h2>
            <p className="text-xs text-[var(--text-secondary)] max-w-2xl">{t('camAi.intro')}</p>
          </div>
          <details className="relative">
            <summary className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5 cursor-pointer list-none">
              <Settings2 size={14} /> {t('camAi.settings')}
            </summary>
            <div className="absolute right-0 z-20 mt-2 w-72 glass-panel rounded-[var(--radius-md)] p-3 space-y-1.5 shadow-lg">
              <label className="space-y-1 block">
                <span className="section-label block">{t('camAi.sideStock')}</span>
                <input className="aurora-input w-full text-xs" type="number" min={0} max={0.5} step={0.01} inputMode="decimal" value={sideStock} onChange={(e) => saveSideStock(Number(e.target.value))} />
              </label>
              <p className="text-xs text-[var(--text-tertiary)]">{t('camAi.sideStockHint')}</p>
            </div>
          </details>
        </header>

        <div className="space-y-1.5">
          <h3 className={h3}>{t('camAi.step.model')}</h3>
          <input ref={fileRef} type="file" accept=".pdf,.stl" className="hidden" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); void pick(e.dataTransfer.files?.[0]); }}
            disabled={busy}
            className="no-glass w-full h-[112px] border-2 border-dashed border-[var(--border-subtle)] hover:border-[var(--blue-500)]/60 rounded-[var(--radius-md)] flex flex-col items-center justify-center gap-1.5 text-xs text-[var(--text-secondary)] transition-colors"
          >
            <Upload size={18} className="text-[var(--blue-text)]" />
            <span className="font-medium text-[var(--text-primary)]">{model ? model.name : t('camAi.drop')}</span>
            <span className="text-[var(--text-tertiary)]">{model ? `${fmt(model.bytes.length / 1048576, 1)} MB · ${t('camAi.change')}` : t('camAi.dropHint')}</span>
          </button>
          {run.state === 'preparing' && <p className="text-xs text-[var(--text-secondary)]" role="status">{t('camAi.reading')}</p>}
        </div>
      </section>

      {prep && (
        <>
          <section className={step} aria-labelledby="cam-part">
            <h3 id="cam-part" className={h3}>{t('camAi.step.part')}</h3>
            {prep.title ? (
              <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
                <div><dt className="inline text-[var(--text-tertiary)]">{t('camAi.part.title')}: </dt><dd className="inline font-medium text-[var(--text-primary)]">{prep.title}</dd></div>
                {prep.sap && <div><dt className="inline text-[var(--text-tertiary)]">{t('camAi.part.sap')}: </dt><dd className="inline font-mono text-[var(--text-primary)]">{prep.sap}</dd></div>}
              </dl>
            ) : (
              <p className="text-xs text-[var(--orange-text)]">{t('camAi.part.noTitle')}</p>
            )}
            <label className="block space-y-1 max-w-md">
              <span className="section-label block">{t('camAi.part.type')}</span>
              <select className="aurora-input w-full text-xs cursor-pointer" value={partType} onChange={(e) => setPartType(e.target.value as PartType)} disabled={busy}>
                <option value="" disabled className="bg-[var(--bg-panel)]">{t('camAi.part.choose')}</option>
                {PART_TYPES.map((p) => (
                  <option key={p} value={p} className="bg-[var(--bg-panel)]">{t(`camAi.part.types.${p}`)}</option>
                ))}
              </select>
            </label>
            <p className="text-xs text-[var(--text-tertiary)]">{t('camAi.part.typeHint')}</p>
          </section>

          <section className={step} aria-labelledby="cam-layout">
            <h3 id="cam-layout" className={h3}>{t('camAi.step.layout')}</h3>
            <ol className="flex flex-wrap items-center gap-2" aria-label={t('camAi.setupSteps')}>
              {[0, 1].map((k) => {
                const open = k === 0 || locked1;
                const done = k === 0 ? locked1 : locked2;
                const active = picking === k;
                return (
                  <li
                    key={k}
                    aria-current={active ? 'step' : undefined}
                    className={`flex items-center gap-2 rounded-full border px-3 min-h-9 text-xs transition-colors ${active ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/10 text-[var(--text-primary)]' : done ? 'border-[#22c55e]/50 text-[var(--text-primary)]' : 'border-[var(--border-subtle)] text-[var(--text-tertiary)]'}`}
                  >
                    {!open ? <Lock size={13} aria-hidden /> : done ? <CheckCircle2 size={14} className="text-[var(--green-text,#1fb257)]" aria-hidden /> : <span className="w-2 h-2 rounded-full bg-[var(--accent-primary)] animate-pulse motion-reduce:animate-none" aria-hidden />}
                    <span className="font-medium">{t('camAi.setupStep', { n: k + 1, op: (k + 1) * 10 })}</span>
                    {open && chosen && <span className="font-mono">{k === 0 ? chosen.side : side2}</span>}
                    <span className="sr-only">{t(!open ? 'camAi.stepState.locked' : done ? 'camAi.stepState.done' : 'camAi.stepState.now')}</span>
                  </li>
                );
              })}
              <li className="text-xs text-[var(--text-tertiary)] px-1">{t('camAi.restByAi')}</li>
            </ol>
            {chosen && (
              <div className="grid lg:grid-cols-[minmax(0,1fr)_16rem] gap-3">
                <Suspense fallback={<div className="h-[380px] rounded-[var(--radius-md)] bg-[rgba(var(--ov),0.04)]" />}>
                  <CamPartView tris={prep.tris} R={chosen.R} raw={raw} picks={picks} picking={picking} onPick={pickFace} label={t('camAi.view3d')} className="h-[380px]" />
                </Suspense>
                <div className="space-y-3 text-xs">
                  {picking !== null ? (
                    <p className="flex items-start gap-2 text-[var(--text-primary)]">
                      <MousePointerClick size={15} className="shrink-0 text-[var(--blue-text)]" aria-hidden />
                      {t('camAi.pickHint', { n: picking + 1 })}
                    </p>
                  ) : (
                    <p className="flex items-start gap-2 text-[var(--text-secondary)]">
                      <CheckCircle2 size={15} className="shrink-0 text-[var(--green-text,#1fb257)]" aria-hidden />
                      {t('camAi.setupsReady')}
                    </p>
                  )}
                  {pickNote && <p role="alert" className="text-[var(--orange-text)]">{t(`camAi.pickNote.${pickNote}`)}</p>}
                  <dl className="space-y-1 text-[var(--text-secondary)]">
                    <div className="flex justify-between gap-2"><dt>{t('camAi.setupStep', { n: 1, op: 10 })}</dt><dd className="text-[var(--text-primary)] text-right"><span className="font-mono">{chosen.side}</span>{chosen.spin ? ` · ${t('camAi.layout.turned')}` : ''}</dd></div>
                    {locked1 && <div className="flex justify-between gap-2"><dt>{t('camAi.setupStep', { n: 2, op: 20 })}</dt><dd className="text-[var(--text-primary)] text-right"><span className="font-mono">{side2}</span>{!second ? ` · ${t('camAi.proposed')}` : ''}</dd></div>}
                  </dl>
                  <div className="flex flex-wrap gap-2">
                    {picking === 0 && (
                      <button type="button" onClick={() => setLocked1(true)} disabled={!chosen.fits} className="btn-primary text-xs min-h-11 px-4 flex items-center gap-1.5">
                        <Check size={14} /> {t('camAi.confirmSetup', { n: 1 })}
                      </button>
                    )}
                    {picking === 1 && (
                      <>
                        <button type="button" onClick={() => setLocked2(true)} className="btn-primary text-xs min-h-11 px-4 flex items-center gap-1.5">
                          <Check size={14} /> {t('camAi.confirmSetup', { n: 2 })}
                        </button>
                        {second && (
                          <button type="button" onClick={() => setSecond(null)} className="btn-secondary text-xs min-h-11 px-3">
                            {t('camAi.useProposal')}
                          </button>
                        )}
                      </>
                    )}
                    {locked1 && !busy && (
                      <button type="button" onClick={() => (locked2 ? setLocked2(false) : (setLocked1(false), setSecond(null)))} className="btn-secondary text-xs min-h-11 px-3 flex items-center gap-1.5">
                        <Pencil size={13} /> {t('camAi.changeSetup', { n: locked2 ? 2 : 1 })}
                      </button>
                    )}
                  </div>
                  <p className="flex flex-wrap gap-x-3 gap-y-1 text-[var(--text-tertiary)]" aria-hidden>
                    <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-[#2f80ff]/60 mr-1" />{t('camAi.legend.hover')}</span>
                    <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-[#22c55e] mr-1" />{t('camAi.legend.top')}</span>
                    <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-[#f5a524] mr-1" />{t('camAi.legend.stock')}</span>
                  </p>
                </div>
              </div>
            )}
            <details className="group">
              <summary className="text-xs text-[var(--text-secondary)] cursor-pointer select-none min-h-9 flex items-center">{t('camAi.layout.others')}</summary>
              <p className="text-xs text-[var(--text-tertiary)] mt-1">{t('camAi.layout.hint')}</p>
              <fieldset className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 mt-2" disabled={busy}>
                <legend className="sr-only">{t('camAi.step.layout')}</legend>
                {prep.layouts.map((l, i) => {
                  const label = `${t('camAi.layout.up', { side: l.side })}${l.spin ? `, ${t('camAi.layout.turned')}` : ''}`;
                  return (
                    <label
                      key={i}
                      className={`relative rounded-[var(--radius-md)] border p-2 text-xs cursor-pointer transition-colors ${layout === i ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/8' : 'border-[var(--border-subtle)] hover:border-[var(--blue-500)]/50'} ${l.fits ? '' : 'opacity-50 cursor-not-allowed'}`}
                    >
                      <input type="radio" name="cam-layout" className="sr-only" checked={layout === i} disabled={!l.fits} onChange={() => { chooseLayout(i); setLocked1(false); }} />
                      {views[i] ? <img src={views[i]} alt="" className="w-full aspect-square object-contain" /> : <div className="w-full aspect-square rounded bg-[rgba(var(--ov),0.05)]" aria-hidden />}
                      <span className="block font-medium text-[var(--text-primary)]">{label}</span>
                      <span className="block text-[var(--text-secondary)] tabular-nums">{t('camAi.layout.size', { x: fmt(l.size[0], 1), y: fmt(l.size[1], 1), z: fmt(l.size[2], 1) })}</span>
                      <span className="block text-[var(--text-tertiary)]">
                        {t('camAi.layout.setups', { count: l.setups })}
                        {l.twoVises && ` · ${t('camAi.layout.twoVises')}`}
                        {!l.fits && ` · ${t('camAi.layout.noFit')}`}
                      </span>
                      {i === 0 && l.fits && <span className="absolute top-1.5 right-1.5 badge-positive text-[10px] py-0.5 px-1.5">{t('camAi.layout.suggested')}</span>}
                    </label>
                  );
                })}
              </fieldset>
            </details>
          </section>

          <section className={step} aria-labelledby="cam-raw">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 id="cam-raw" className={h3}>{t('camAi.step.raw')}</h3>
              <button type="button" role="switch" aria-checked={autoStock} onClick={() => setAutoStock(!autoStock)} disabled={busy} className="no-glass flex items-center gap-2 text-xs text-[var(--text-primary)] min-h-11">
                <span className={`relative w-9 h-5 rounded-full transition-colors ${autoStock ? 'bg-[var(--accent-primary)]' : 'bg-[rgba(var(--ov),0.22)]'}`} aria-hidden>
                  <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${autoStock ? 'translate-x-4' : ''}`} />
                </span>
                {t('camAi.stock.auto')}
              </button>
            </div>
            {!autoStock && chosen && (
              <fieldset className="space-y-2" disabled={busy}>
                <legend className="sr-only">{t('camAi.stock.manual')}</legend>
                <div className="inline-flex rounded-[var(--radius-md)] border border-[var(--border-subtle)] p-0.5" role="radiogroup" aria-label={t('camAi.stock.manual')}>
                  {(['total', 'side'] as const).map((m) => (
                    <button key={m} type="button" role="radio" aria-checked={stockMode === m} onClick={() => setStockMode(m)} className={`no-glass text-xs px-3 min-h-9 rounded-[calc(var(--radius-md)-2px)] ${stockMode === m ? 'bg-[var(--accent-primary)]/15 text-[var(--text-primary)] font-medium' : 'text-[var(--text-secondary)]'}`}>
                      {t(`camAi.stock.${m}`)}
                    </button>
                  ))}
                </div>
                <div className="flex gap-2 max-w-md">
                  {(['X', 'Y', 'Z'] as const).map((axis, k) => {
                    const list = stockMode === 'total' ? totals : perSide;
                    const set = stockMode === 'total' ? setTotals : setPerSide;
                    return (
                      <label key={axis} className="flex-1 space-y-1">
                        <span className="section-label block">{t(stockMode === 'total' ? 'camAi.stock.totalAxis' : 'camAi.stock.sideAxis', { axis })}</span>
                        <input className="aurora-input w-full min-w-0 text-xs px-2" type="number" min={0} step={0.5} inputMode="decimal" value={list[k]} onChange={(e) => set(list.map((v, i) => (i === k ? e.target.value : v)))} />
                      </label>
                    );
                  })}
                </div>
                {!excessOk && <p className="text-xs text-[var(--orange-text)]" role="alert">{t('camAi.stock.tooSmall')}</p>}
              </fieldset>
            )}
            {raw && chosen && excess && (
              <p className="text-xs text-[var(--text-secondary)] tabular-nums">
                {t('camAi.rawStep.result', { size: [0, 1, 2].map((k) => fmt(chosen.size[k] + excess[k], 1)).join(' × ') })}
                {' · '}
                {t('camAi.stock.added', { x: fmt(excess[0], 1), y: fmt(excess[1], 1), z: fmt(excess[2], 1) })}
              </p>
            )}
          </section>

          <section className={step} aria-labelledby="cam-machine">
            <h3 id="cam-machine" className={h3}>{t('camAi.step.machine')}</h3>
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="section-label block">{t('camAi.machine')}</span>
                <select className="aurora-input w-full text-xs cursor-pointer" value={machine?.id ?? ''} onChange={(e) => setMachineId(e.target.value)} disabled={busy}>
                  {toolMachines.map((m) => (
                    <option key={m.id} value={m.id} className="bg-[var(--bg-panel)]">
                      {t('controls.machineOption', { name: m.name, count: (toolbox[m.id] || []).length })}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="section-label block">{t('camAi.material')}</span>
                <select className="aurora-input w-full text-xs cursor-pointer" value={material} onChange={(e) => setMaterial(e.target.value as CamMaterial | 'INOX' | 'OTHER')} disabled={busy}>
                  {CAM_MATERIALS.map((m) => (
                    <option key={m} value={m} className="bg-[var(--bg-panel)]">{m}</option>
                  ))}
                  <option value="INOX" className="bg-[var(--bg-panel)]">{t('camAi.inox')}</option>
                  <option value="OTHER" className="bg-[var(--bg-panel)]">{t('camAi.otherMaterial')}</option>
                </select>
              </label>
            </div>
            {material === 'INOX' && (
              <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius-md)] border border-[#f5b942]/40 bg-[#f5b942]/8 p-3 text-xs" role="alert">
                <AlertTriangle size={14} className="text-[var(--orange-text)] shrink-0" />
                <span className="text-[var(--text-primary)]">{t('camAi.inoxAsk')}</span>
                <button type="button" onClick={() => setMaterial('MS')} className="btn-primary text-xs py-1 px-3">
                  {t('camAi.useMs')}
                </button>
              </div>
            )}
            {material === 'OTHER' && (
              <label className="block space-y-1 max-w-sm">
                <span className="section-label block">{t('camAi.family')}</span>
                <select className="aurora-input w-full text-xs cursor-pointer" value={family} onChange={(e) => setFamily(e.target.value as Family)} disabled={busy}>
                  {(['ALU', 'POM', 'FH'] as const).map((f) => (
                    <option key={f} value={f} className="bg-[var(--bg-panel)]">{t(`camAi.families.${f}`)}</option>
                  ))}
                </select>
              </label>
            )}
            <div className="flex flex-wrap items-center justify-end gap-3 pt-1">
              {!tools.length && machine && <span className="text-xs text-[var(--orange-text)]">{t('camAi.noTools', { name: machine.name })}</span>}
              {run.state === 'busy' ? (
                <button type="button" onClick={stop} className="btn-secondary text-xs py-2 px-4 flex items-center gap-1.5">
                  <Square size={12} /> {t('camAi.stop')}
                </button>
              ) : (
                <button type="button" onClick={() => generate()} disabled={!ready || busy} className="btn-primary text-xs py-2 px-5 flex items-center gap-1.5">
                  <Cpu size={14} /> {t(result ? 'camAi.again' : 'camAi.generate')}
                </button>
              )}
            </div>
            {chosen && (run.state === 'busy' || (result && live.paths.length > 0)) && (
              <div className="grid lg:grid-cols-[minmax(0,1fr)_19rem] gap-3 pt-1">
                <Suspense fallback={<div className="h-[340px] rounded-[var(--radius-md)] bg-[rgba(var(--ov),0.04)]" />}>
                  <CamPartView tris={prep.tris} R={chosen.R} raw={raw} picks={[]} picking={null} paths={live.paths} label={t('camAi.live.view')} className="h-[340px]" />
                </Suspense>
                <LiveConsole live={live} done={!!result} excess={excess ?? AUTO_EXCESS} />
              </div>
            )}
          </section>
        </>
      )}

      {run.state === 'error' && (
        <div className="badge-danger text-xs py-1.5 px-3" role="alert">
          {run.error === 'failed' ? t('camAi.failed') : t(`toolpath.model.errors.${run.error}`)}
        </div>
      )}

      {result && machine && templatesFor && (
        <CamAiResult
          result={result}
          machineName={machine.name}
          machineTools={tools}
          material={templatesFor}
          exclude={swap.exclude}
          cuts={cuts}
          busy={busy}
          onRecalc={(next) => {
            setCuts(next);
            generate(swap, next);
          }}
          onSwap={(code, standIn) => {
            const next = { exclude: [...swap.exclude, code], prefer: [...swap.prefer, standIn] };
            setSwap(next);
            generate(next);
          }}
          onView={() => setViewing(true)}
          onDownload={download}
          onSend={() => passed(result) && onSend(result.code, fileName, machine.id)}
        />
      )}

      {viewing && result && model && (
        <Suspense fallback={null}>
          <ToolpathViewer code={result.code} title={fileName} brand={machine?.brand} onClose={() => setViewing(false)} initialModel={model} noRecord />
        </Suspense>
      )}
    </div>
  );
}

/** One step of the planner into what the page shows (cam.worker 'live'). */
function liveStep(l: Live, e: LiveEvent): Live {
  if (e.kind === 'reset') return NO_LIVE;
  if (e.kind === 'path') return { ...l, paths: [...l.paths, { setup: e.setup, purpose: e.purpose, pts: e.pts }] };
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
