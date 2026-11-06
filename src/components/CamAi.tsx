import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Cpu, Download, Route, Send, Square, Upload } from 'lucide-react';
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
import { MATERIALS, type Material } from '../types';
import type { CamMessage, CamRequest, CamSummary } from '../lib/cam/cam.worker';

const ToolpathViewer = lazy(() => import('./ToolpathViewer'));

type Model = { name: string; bytes: Uint8Array };
type Run = { state: 'idle' } | { state: 'busy'; done: number; of: number } | { state: 'error'; error: ModelError | 'failed' } | { state: 'done'; result: CamSummary };


/**
 * CAM AI: a part's 3D model in, the program for the chosen machine out, made with that machine's
 * tools and the shop's learned cutting data, then simulated and compared with the model before
 * it can be used (lib/cam/program.ts).
 */
export default function CamAi({ onSend }: { onSend: (code: string, fileName: string, machine: string) => void }) {
  const { t } = useT('remapper');
  const { toolbox, toolMachines } = useSync();
  const [model, setModel] = useState<Model | null>(null);
  const [machineId, setMachineId] = useState(() => toolMachines[0]?.id ?? '');
  const [material, setMaterial] = useState<Material>('FH');
  const [raw, setRaw] = useState(['', '', '']);
  const [run, setRun] = useState<Run>({ state: 'idle' });
  const [viewing, setViewing] = useState(false);
  const worker = useRef<Worker | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const machine = toolMachines.find((m) => m.id === machineId) ?? toolMachines[0];
  const tools = machine ? toolbox[machine.id] ?? [] : [];
  const name = model ? model.name.replace(/\.(pdf|stl)$/i, '') : '';
  const fileName = `${name || 'CAM_AI'}.nc`;

  useEffect(() => () => worker.current?.terminate(), []);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MODEL_MAX_BYTES) return setRun({ state: 'error', error: 'tooBig' });
    setModel({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    setRun({ state: 'idle' });
  };

  const stop = () => {
    worker.current?.terminate();
    worker.current = null;
    setRun({ state: 'idle' });
  };

  const generate = () => {
    if (!model || !machine) return;
    worker.current?.terminate();
    const w = new Worker(new URL('../lib/cam/cam.worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    const sizes = raw.map(Number);
    const speeds = speedsFor(machine.brand);
    const request: CamRequest = {
      model,
      material,
      tools,
      brand: machine.brand,
      name: name.slice(0, 40),
      // All three, or none: the model plus the shop's learned allowance.
      raw: sizes.every((v) => v > 0) ? (sizes as [number, number, number]) : null,
      limits: { maxRpm: machine.maxRpm ?? DEFAULT_LIMITS.maxRpm, maxFeed: machine.maxFeed ?? DEFAULT_LIMITS.maxFeed },
      speeds: { rapid: machine.rapid ?? speeds.rapid, toolChange: machine.toolChange ?? speeds.toolChange },
    };
    w.onmessage = (e: MessageEvent<CamMessage>) => {
      const m = e.data;
      if (m.type === 'progress') return setRun({ state: 'busy', done: m.done, of: m.of });
      w.terminate();
      worker.current = null;
      if (m.type === 'error') return setRun({ state: 'error', error: m.error });
      setRun({ state: 'done', result: m.result });
      // A part record for the learning records (Admin > Data). Best effort.
      if (m.lesson) void api('/toolpath/lessons', { body: { kind: 'part', fileName, start: m.result.match, match: m.result.match, data: m.lesson }, timeoutMs: 120_000 }).catch(() => {});
    };
    w.onerror = () => {
      w.terminate();
      worker.current = null;
      setRun({ state: 'error', error: 'failed' });
    };
    setRun({ state: 'busy', done: 0, of: 3 });
    w.postMessage(request);
  };

  const result = run.state === 'done' ? run.result : null;
  // Proven: as the model (99 %) and nothing hit. Otherwise it can be looked at, not used.
  const proven = !!result && result.match >= 0.99 && result.collisions === 0;
  const download = () => {
    if (!result || !machine) return;
    const fanuc = machine.brand === 'FANUC' && engineMachineId(currentRegion().id, machine) !== 'FANUC-2';
    const code = fanuc ? convertHaasToFanuc(result.code, fileName).fanucCode : result.code;
    downloadBlob(fileName, new Blob([code], { type: 'text/plain' }));
  };
  const why = (n: CamSummary['missing'][number]) => {
    const { key, ...v } = n.why;
    return t(`camAi.why.${key}`, v);
  };
  const note = (n: CamSummary['notes'][number]) => {
    const { key, ...v } = n;
    return t(`camAi.note.${key}`, v);
  };

  return (
    <div className="max-w-5xl mx-auto w-full space-y-4 pb-16">
      <section className="glass-panel rounded-[var(--radius-lg)] p-5 space-y-5" aria-labelledby="cam-title">
        <header className="flex items-start gap-3">
          <span className="w-10 h-10 shrink-0 rounded-[var(--radius-md)] bg-[var(--accent-primary)]/12 text-[var(--accent-primary)] flex items-center justify-center">
            <Cpu size={20} />
          </span>
          <div className="space-y-1">
            <h2 id="cam-title" className="text-base font-semibold text-[var(--text-primary)] flex items-center gap-2">
              CAM AI <span className="badge-warning text-[10px] py-0.5 px-1.5">{t('camAi.beta')}</span>
            </h2>
            <p className="text-xs text-[var(--text-secondary)] max-w-2xl">{t('camAi.intro')}</p>
          </div>
        </header>

        <div className="grid md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <span className="section-label block">{t('camAi.model')}</span>
            <input ref={fileRef} type="file" accept=".pdf,.stl" className="hidden" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); void pick(e.dataTransfer.files?.[0]); }}
              disabled={run.state === 'busy'}
              className="no-glass w-full h-[132px] border-2 border-dashed border-[var(--border-subtle)] hover:border-[var(--blue-500)]/60 rounded-[var(--radius-md)] flex flex-col items-center justify-center gap-1.5 text-xs text-[var(--text-secondary)] transition-colors"
            >
              <Upload size={18} className="text-[var(--blue-text)]" />
              <span className="font-medium text-[var(--text-primary)]">{model ? model.name : t('camAi.drop')}</span>
              <span className="text-[var(--text-tertiary)]">{model ? `${fmt(model.bytes.length / 1048576, 1)} MB · ${t('camAi.change')}` : t('camAi.dropHint')}</span>
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3 content-start">
            <label className="space-y-1 col-span-2">
              <span className="section-label block">{t('camAi.machine')}</span>
              <select className="aurora-input w-full text-xs cursor-pointer" value={machine?.id ?? ''} onChange={(e) => setMachineId(e.target.value)} disabled={run.state === 'busy'}>
                {toolMachines.map((m) => (
                  <option key={m.id} value={m.id} className="bg-[var(--bg-panel)]">
                    {t('controls.machineOption', { name: m.name, count: (toolbox[m.id] || []).length })}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="section-label block">{t('camAi.material')}</span>
              <select className="aurora-input w-full text-xs cursor-pointer" value={material} onChange={(e) => setMaterial(e.target.value as Material)} disabled={run.state === 'busy'}>
                {MATERIALS.map((m) => (
                  <option key={m} value={m} className="bg-[var(--bg-panel)]">{m}</option>
                ))}
              </select>
            </label>
            <fieldset className="space-y-1">
              <legend className="section-label">{t('camAi.raw')}</legend>
              <div className="flex gap-1">
                {(['X', 'Y', 'Z'] as const).map((axis, k) => (
                  <input
                    key={axis}
                    className="aurora-input w-full min-w-0 text-xs px-2"
                    type="number"
                    min={1}
                    max={2000}
                    inputMode="decimal"
                    placeholder={axis}
                    aria-label={t('camAi.rawAxis', { axis })}
                    value={raw[k]}
                    disabled={run.state === 'busy'}
                    onChange={(e) => setRaw(raw.map((v, i) => (i === k ? e.target.value : v)))}
                  />
                ))}
              </div>
            </fieldset>
            <p className="col-span-2 text-xs text-[var(--text-tertiary)]">{t('camAi.rawHint')}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-3">
          {!tools.length && machine && <span className="text-xs text-[var(--orange-text)]">{t('camAi.noTools', { name: machine.name })}</span>}
          {run.state === 'busy' ? (
            <button type="button" onClick={stop} className="btn-secondary text-xs py-2 px-4 flex items-center gap-1.5">
              <Square size={12} /> {t('camAi.stop')}
            </button>
          ) : (
            <button type="button" onClick={generate} disabled={!model || !machine || !tools.length} className="btn-primary text-xs py-2 px-5 flex items-center gap-1.5">
              <Cpu size={14} /> {t(result ? 'camAi.again' : 'camAi.generate')}
            </button>
          )}
        </div>

        {run.state === 'busy' && (
          <div className="space-y-1.5" role="status">
            <div className="flex justify-between text-xs text-[var(--text-secondary)]">
              <span>{run.done === 0 ? t('camAi.reading') : t('camAi.trying', { n: Math.min(run.done + 1, run.of), of: run.of })}</span>
              <span>{t('camAi.slow')}</span>
            </div>
            <div className="h-1.5 rounded-full bg-[rgba(var(--ov),0.08)] overflow-hidden">
              <div className="h-full bg-[var(--accent-primary)] transition-[width] duration-500" style={{ width: `${Math.max(6, (run.done / run.of) * 100)}%` }} />
            </div>
          </div>
        )}
        {run.state === 'error' && (
          <div className="badge-danger text-xs py-1.5 px-3" role="alert">
            {run.error === 'failed' ? t('camAi.failed') : t(`toolpath.model.errors.${run.error}`)}
          </div>
        )}
      </section>

      {result && (
        <section className="glass-panel rounded-[var(--radius-lg)] p-5 space-y-5" aria-labelledby="cam-result">
          <h3 id="cam-result" className="sr-only">{t('camAi.result')}</h3>
          <div className={`flex items-start gap-2 text-sm font-medium ${proven ? 'text-[var(--green-text,#1fb257)]' : 'text-[var(--orange-text)]'}`} role="status">
            {proven ? <CheckCircle2 size={18} className="shrink-0" /> : <AlertTriangle size={18} className="shrink-0" />}
            <span>{proven ? t('camAi.proven') : result.collisions ? t('camAi.collisions', { count: result.collisions }) : t('camAi.notProven')}</span>
          </div>

          {result.cales > 0 && (
            <p className="text-xs text-[var(--orange-text)] flex items-start gap-1.5">
              <AlertTriangle size={14} className="shrink-0 mt-px" /> {t('editor.caleWarning', { count: result.cales })}
            </p>
          )}
          <dl className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              [t('camAi.match'), t('camAi.percent', { v: fmt(result.match * 100, 2) })],
              [t('camAi.time'), t('camAi.minutes', { v: fmt(result.minutes, 1) })],
              [t('camAi.toolChanges'), String(result.toolChanges)],
              [t('camAi.setups'), String(result.setups.length)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] p-3">
                <dt className="text-xs text-[var(--text-tertiary)]">{label}</dt>
                <dd className="text-lg font-semibold text-[var(--text-primary)] tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-[var(--text-tertiary)]">
            {t('camAi.sizes', { size: result.size.map((v) => fmt(v, 1)).join(' × '), raw: result.raw.map((v) => fmt(v, 1)).join(' × ') })}
          </p>

          {result.missing.length > 0 && (
            <div className="rounded-[var(--radius-md)] border border-[#f5b942]/40 bg-[#f5b942]/8 p-3 space-y-2">
              <h4 className="text-xs font-semibold text-[var(--orange-text)] flex items-center gap-1.5">
                <AlertTriangle size={14} /> {t('camAi.missing', { name: machine?.name ?? '' })}
              </h4>
              <ul className="text-xs text-[var(--text-secondary)] space-y-1">
                {result.missing.map((n, i) => (
                  <li key={i}>
                    <span className="font-medium text-[var(--text-primary)]">
                      {t(`common:category.${n.category}`, { defaultValue: n.category })} Ø{fmt(n.diameter, 2)}
                      {n.minLength > 0 && `, ${t('camAi.minLength', { mm: n.minLength })}`}
                    </span>{' '}
                    · {why(n)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <ol className="space-y-3">
            {result.setups.map((s, i) => (
              <li key={i} className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] p-3 space-y-2">
                <div className="text-xs font-semibold text-[var(--text-primary)]">{t('camAi.setup', { n: i + 1, side: s.side })}</div>
                <div className="font-mono text-xs text-[var(--text-secondary)] space-y-0.5">
                  {s.notes.map((n, k) => <div key={k}>M0 ({n})</div>)}
                </div>
                <ul className="flex flex-wrap gap-1.5" aria-label={t('camAi.ops')}>
                  {s.ops.map((o, k) => (
                    <li key={k} className="rounded-full bg-[rgba(var(--ov),0.06)] px-2 py-0.5 text-xs text-[var(--text-secondary)]" title={o.learned ? t('camAi.learned') : t('camAi.default')}>
                      T{o.tool} · {o.name}
                      {!o.learned && ' *'}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
          {result.setups.some((s) => s.ops.some((o) => !o.learned)) && <p className="text-xs text-[var(--text-tertiary)]">* {t('camAi.default')}</p>}

          {result.notes.length > 0 && (
            <ul className="text-xs text-[var(--text-secondary)] list-disc pl-5 space-y-0.5">
              {result.notes.map((n, i) => <li key={i}>{note(n)}</li>)}
            </ul>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={() => setViewing(true)} className="btn-secondary text-xs py-2 px-4 flex items-center gap-1.5">
              <Route size={14} /> {t('camAi.view')}
            </button>
            <button type="button" onClick={download} disabled={!proven} className="btn-secondary text-xs py-2 px-4 flex items-center gap-1.5" title={proven ? undefined : t('camAi.locked')}>
              <Download size={14} /> {t('camAi.download')}
            </button>
            <button type="button" onClick={() => machine && onSend(result.code, fileName, machine.id)} disabled={!proven} className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5" title={proven ? undefined : t('camAi.locked')}>
              <Send size={14} /> {t('camAi.send')}
            </button>
          </div>
          {!proven && <p className="text-xs text-[var(--text-tertiary)] text-right">{t('camAi.locked')}</p>}
        </section>
      )}

      {viewing && result && model && (
        <Suspense fallback={null}>
          <ToolpathViewer code={result.code} title={fileName} brand={machine?.brand} onClose={() => setViewing(false)} initialModel={model} noRecord />
        </Suspense>
      )}
    </div>
  );
}
