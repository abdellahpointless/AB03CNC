import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Cpu, Settings2, Square, Upload } from 'lucide-react';
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
import type { Mat3 } from '../lib/orient';
import CamAiResult, { passed } from './CamAiResult';

const ToolpathViewer = lazy(() => import('./ToolpathViewer'));

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
  const [rawMode, setRawMode] = useState<'same' | 'bigger' | ''>('');
  const [excess, setExcess] = useState(['', '', '']);
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
  const excessOk = excess.every((v) => v !== '' && Number(v) >= 0 && Number(v) <= 200);
  const raw = prep && chosen && (rawMode === 'same' || (rawMode === 'bigger' && excessOk))
    ? (toModelAxes(chosen.R, rawMode === 'same' ? [0, 0, 0] : excess.map(Number)).map((e, k) => prep.size[k] + e) as [number, number, number])
    : null;
  const ready = !!prep && !!partType && !!chosen?.fits && !!raw && !!machine && tools.length > 0 && !!templatesFor;

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
    setRawMode('');
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
      setLayout(Math.max(0, msg.layouts.findIndex((l) => l.fits)));
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

  const generate = (with_ = swap) => {
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
      limits: { maxRpm: machine.maxRpm ?? DEFAULT_LIMITS.maxRpm, maxFeed: machine.maxFeed ?? DEFAULT_LIMITS.maxFeed },
      speeds: { rapid: machine.rapid ?? speeds.rapid, toolChange: machine.toolChange ?? speeds.toolChange },
    };
    w.onmessage = (e: MessageEvent<CamMessage>) => {
      const m = e.data;
      if (m.type === 'progress') return setRun({ state: 'busy', done: m.done, of: m.of });
      if (m.type === 'prepared') return;
      w.terminate();
      worker.current = null;
      if (m.type === 'error') return setRun({ state: 'error', error: m.error });
      setRun({ state: 'done', result: m.result });
      // A part record for the learning records (Admin > Data). Best effort; only programs that
      // passed every check (a failed run would teach the wrong thing).
      if (m.lesson && passed(m.result)) void api('/toolpath/lessons', { body: { kind: 'part', fileName, start: m.result.match, match: m.result.match, data: m.lesson }, timeoutMs: 120_000 }).catch(() => {});
    };
    setRun({ state: 'busy', done: 0, of: 1 });
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
            <p className="text-xs text-[var(--text-tertiary)]">{t('camAi.layout.hint')}</p>
            <fieldset className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2" disabled={busy}>
              <legend className="sr-only">{t('camAi.step.layout')}</legend>
              {prep.layouts.map((l, i) => {
                const label = `${t('camAi.layout.up', { side: l.side })}${l.spin ? `, ${t('camAi.layout.turned')}` : ''}`;
                return (
                  <label
                    key={i}
                    className={`relative rounded-[var(--radius-md)] border p-2 text-xs cursor-pointer transition-colors ${layout === i ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/8' : 'border-[var(--border-subtle)] hover:border-[var(--blue-500)]/50'} ${l.fits ? '' : 'opacity-50 cursor-not-allowed'}`}
                  >
                    <input type="radio" name="cam-layout" className="sr-only" checked={layout === i} disabled={!l.fits} onChange={() => setLayout(i)} />
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
          </section>

          <section className={step} aria-labelledby="cam-raw">
            <h3 id="cam-raw" className={h3}>{t('camAi.step.raw')}</h3>
            <fieldset className="space-y-2" disabled={busy}>
              <legend className="sr-only">{t('camAi.step.raw')}</legend>
              <label className="flex items-center gap-2 text-xs text-[var(--text-primary)] cursor-pointer">
                <input type="radio" name="cam-raw" checked={rawMode === 'same'} onChange={() => setRawMode('same')} /> {t('camAi.rawStep.same')}
              </label>
              <label className="flex items-center gap-2 text-xs text-[var(--text-primary)] cursor-pointer">
                <input type="radio" name="cam-raw" checked={rawMode === 'bigger'} onChange={() => setRawMode('bigger')} /> {t('camAi.rawStep.bigger')}
              </label>
              {rawMode === 'bigger' && (
                <div className="flex gap-2 pl-6 max-w-sm">
                  {(['X', 'Y', 'Z'] as const).map((axis, k) => (
                    <label key={axis} className="flex-1 space-y-1">
                      <span className="section-label block">{axis}</span>
                      <input
                        className="aurora-input w-full min-w-0 text-xs px-2"
                        type="number"
                        min={0}
                        max={200}
                        step={0.5}
                        inputMode="decimal"
                        aria-label={t('camAi.rawStep.excess', { axis })}
                        value={excess[k]}
                        onChange={(e) => setExcess(excess.map((v, i) => (i === k ? e.target.value : v)))}
                      />
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
            {raw && chosen ? (
              <p className="text-xs text-[var(--text-secondary)] tabular-nums">
                {t('camAi.rawStep.result', {
                  size: [0, 1, 2]
                    .map((k) => chosen.size[k] + (rawMode === 'bigger' ? Number(excess[k]) : 0))
                    .map((v) => fmt(v, 1))
                    .join(' × '),
                })}
              </p>
            ) : (
              <p className="text-xs text-[var(--text-tertiary)]">{t('camAi.rawStep.required')}</p>
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
            {run.state === 'busy' && (
              <div className="space-y-1.5" role="status">
                <div className="flex justify-between text-xs text-[var(--text-secondary)]">
                  <span>{t('camAi.making')}</span>
                  <span>{t('camAi.slow')}</span>
                </div>
                <div className="h-1.5 rounded-full bg-[rgba(var(--ov),0.08)] overflow-hidden">
                  <div className="h-full bg-[var(--accent-primary)] transition-[width] duration-500" style={{ width: `${Math.max(6, (run.done / Math.max(1, run.of)) * 100)}%` }} />
                </div>
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
