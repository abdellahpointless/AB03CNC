import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Copy, Download, Play, Square, AlertTriangle, Sparkles, Undo2 } from 'lucide-react';
import type { Toolpath, Vec } from '../lib/toolpath';
import type { Mat3 } from '../lib/orient';
import type { SearchProgress, TurnFix, TurnSearch } from '../lib/fixTurns';
import { TARGET } from '../lib/fixTurns';
import { PIECE_COLORS, type ModelState } from './Toolpath3D';
import { chime } from '../lib/alarm';
import { api } from '../lib/api';
import { partLessonOf } from '../lib/lessons';
import { downloadText } from '../lib/download';
import { useT } from '../i18n';
import { fmtNumber } from '../i18n/format';

type Search =
  | { status: 'running'; p: SearchProgress }
  | { status: 'done'; result: TurnSearch; fix: TurnFix | null }
  | { status: 'stopped'; p: SearchProgress }
  | { status: 'error' };

const pct = (x: number) => fmtNumber(Math.floor(x * 10000) / 100);

/**
 * The real part against the simulation: how alike they are, where they differ and, when they do,
 * the search for the right turns (every way each setup can lie, simulated in a worker), then the
 * found turns to simulate and the program with its M0 comments rewritten for them.
 */
export default function ModelCheck({
  model,
  state,
  code,
  brand,
  fileName,
  path,
  using,
  onSimulate,
  onFocus,
  onUseFix,
}: {
  model: { name: string; bytes: Uint8Array };
  state: ModelState | null;
  code: string;
  brand?: string;
  fileName: string;
  path: Toolpath;
  /** The found turns are simulated (not the program's). */
  using: boolean;
  onSimulate: (orients: Mat3[] | null) => void;
  /** Fly the camera to this point of the part (part frame). */
  onFocus: (p: Vec) => void;
  /** Put the corrected comments into the program in the editor; false when they could not be placed. */
  onUseFix?: (changes: TurnFix['changes']) => boolean;
}) {
  const { t } = useT('remapper');
  const [search, setSearch] = useState<Search | null>(null);
  const [showFix, setShowFix] = useState(false);
  const [used, setUsed] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);
  const worker = useRef<Worker | null>(null);
  const searched = useRef<object | null>(null);

  // A new model: everything about the old one goes.
  useEffect(() => {
    setSearch(null);
    setShowFix(false);
    setUsed(null);
    return () => worker.current?.terminate();
  }, [model]);

  const ready = state?.state === 'ready' ? state : null;

  // A part record (lib/lessons): this program with its model, once per model. Best effort.
  const recorded = useRef<object | null>(null);
  useEffect(() => {
    if (!ready || using || recorded.current === model) return;
    recorded.current = model;
    void partLessonOf({ code, tp: path, model, match: ready.match, pieces: ready.pieces, brand, source: 'program' })
      .then((data) => api('/toolpath/lessons', { body: { kind: 'part', fileName, start: ready.match, match: ready.match, data }, timeoutMs: 120_000 }))
      .catch(() => {});
  }, [ready, using, model, code, path, brand, fileName]);

  // Not alike enough with the program's own turns: try every turn, once per model.
  useEffect(() => {
    if (!ready || using || ready.match >= TARGET || searched.current === model) return;
    searched.current = model;
    const w = new Worker(new URL('../lib/stockSim.worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    setSearch({ status: 'running', p: { count: 1, total: 1, best: ready.match, stage: 'written' } });
    w.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === 'searching') setSearch({ status: 'running', p: msg });
      if (msg.type !== 'search') return;
      w.terminate();
      if (!msg.result) return setSearch({ status: 'error' });
      setSearch({ status: 'done', result: msg.result, fix: msg.fix });
      if (!msg.result.same) chime();
      // The learning record (see lib/lessons): best effort, the user is not bothered if it fails.
      if (msg.lesson) void api('/toolpath/lessons', { body: { fileName, start: msg.result.start, match: msg.result.match, data: msg.lesson } }).catch(() => {});
    };
    w.postMessage({ type: 'search', bytes: model.bytes, code, brand });
  }, [ready, using, model, code, brand, fileName]);

  const stop = () => {
    worker.current?.terminate();
    if (search?.status === 'running') setSearch({ status: 'stopped', p: search.p });
  };

  const done = search?.status === 'done' ? search : null;
  const found = done && !done.result.same ? done.result : null;
  const right = found && found.match >= TARGET;
  const corrected = done?.fix ?? null;

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[rgba(var(--ov),0.03)] p-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <Sparkles size={14} className="text-[#8fb3e0]" />
        <span className="text-xs font-bold text-[var(--text-primary)]">{t('toolpath.model.check')}</span>
        {ready && <span className={`ml-auto text-[11px] font-mono font-bold ${ready.match >= TARGET ? 'text-[var(--green-500)]' : 'text-[#f5b942]'}`}>{pct(ready.match)} %</span>}
      </div>

      {ready && ready.match >= TARGET && !using && (
        <p className="flex gap-2 text-xs text-[var(--green-500)]">
          <CheckCircle2 size={14} className="shrink-0 mt-px" />
          {t('toolpath.model.good')}
        </p>
      )}

      {(search?.status === 'running' || search?.status === 'stopped') && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs text-[var(--text-primary)]" aria-live="polite">
            <span className="flex-1 min-w-0">
              {search.status === 'running' ? t('toolpath.model.searching', { count: search.p.count }) : t('toolpath.model.stopped', { count: search.p.count })}
              {search.status === 'running' && <span className="block text-[11px] text-[var(--text-secondary)]">{t(`toolpath.model.stage.${search.p.stage}`)}</span>}
              <span className="text-[var(--text-secondary)]"> · {t('toolpath.model.best', { pct: pct(search.p.best) })}</span>
            </span>
            {search.status === 'running' && (
              <button onClick={stop} className="btn-secondary text-[11px] py-0.5 px-2 shrink-0">
                <Square size={10} />
                {t('toolpath.model.stop')}
              </button>
            )}
          </div>
          <div
            role="progressbar"
            aria-label={t('toolpath.model.searching', { count: search.p.count })}
            aria-valuemin={0}
            aria-valuemax={search.p.total}
            aria-valuenow={search.p.count}
            className="h-1.5 rounded-full bg-[rgba(var(--ov),0.08)] overflow-hidden"
          >
            <div className="h-full rounded-full bg-[#8fb3e0] transition-[width] duration-300" style={{ width: `${Math.min(100, (search.p.count / Math.max(1, search.p.total)) * 100)}%` }} />
          </div>
        </div>
      )}

      {search?.status === 'error' && <p className="text-xs text-[#f5b942]">{t('toolpath.model.errors.notPart')}</p>}

      {done && done.result.same && <p className="flex gap-2 text-xs text-[#f5b942]"><AlertTriangle size={14} className="shrink-0 mt-px" />{t('toolpath.model.noBetter', { pct: pct(done.result.match) })}</p>}

      {found && (
        <div className="space-y-2">
          <button
            onClick={() => onSimulate(using ? null : found.orients)}
            aria-pressed={using}
            className={`w-full inline-flex items-center justify-center gap-1.5 rounded-full border px-3 h-8 text-xs font-bold transition-shadow ${
              right ? 'border-[#22c55e] bg-[#22c55e]/15 text-[#4ade80] shadow-[0_0_18px_rgba(34,197,94,0.55)]' : 'border-[#f5b942] bg-[#f5b942]/10 text-[#f5b942]'
            }`}
          >
            {using ? <Undo2 size={13} /> : <Play size={13} />}
            {using ? t('toolpath.model.back') : t(right ? 'toolpath.model.found' : 'toolpath.model.closest', { pct: pct(found.match), count: found.count })}
          </button>
          {corrected && (
            <button onClick={() => setShowFix((x) => !x)} aria-expanded={showFix} className="btn-secondary w-full text-xs py-1">
              {t('toolpath.model.fixTitle')} ({corrected.changes.length})
            </button>
          )}
          {corrected && showFix && (
            <div className="space-y-2">
              <p className="text-[11px] text-[var(--text-secondary)]">{t('toolpath.model.fixHelp')}</p>
              <ul className="space-y-1.5">
                {corrected.changes.map((c) => (
                  <li key={c.line} className="rounded-md bg-[rgba(var(--ov),0.04)] p-2 font-mono text-[11px] leading-snug break-words">
                    <div className="text-[var(--text-tertiary)]">{t('toolpath.model.line', { n: c.line + 1 })}</div>
                    <div className="text-[#ff8a9a] line-through decoration-1">{c.from.trim()}</div>
                    <div className="text-[#4ade80]">{c.to.trim()}</div>
                  </li>
                ))}
              </ul>
              {corrected.unresolved.map((k) => (
                <p key={k} className="flex gap-2 text-[11px] text-[#f5b942]"><AlertTriangle size={13} className="shrink-0 mt-px" />{t('toolpath.model.unresolved', { n: k + 1 })}</p>
              ))}
              <div className="flex flex-wrap gap-1.5">
                {onUseFix && (
                  <button onClick={() => setUsed(onUseFix(corrected.changes))} className="btn-primary text-xs py-1 px-2.5">
                    <CheckCircle2 size={12} />
                    {t('toolpath.model.use')}
                  </button>
                )}
                <button
                  onClick={() => {
                    void navigator.clipboard?.writeText(corrected.code).then(() => setCopied(true));
                  }}
                  className="btn-secondary text-xs py-1 px-2.5"
                >
                  <Copy size={12} />
                  {copied ? t('toolpath.model.copied') : t('toolpath.model.copy')}
                </button>
                <button onClick={() => downloadText(fileName, corrected.code)} className="btn-secondary text-xs py-1 px-2.5">
                  <Download size={12} />
                  {t('toolpath.model.download')}
                </button>
              </div>
              {used !== null && <p className={`text-[11px] ${used ? 'text-[var(--green-500)]' : 'text-[#f5b942]'}`} role="status">{t(used ? 'toolpath.model.used' : 'toolpath.model.notUsed')}</p>}
            </div>
          )}
        </div>
      )}

      {ready && ready.pieces.length > 0 && (
        <div className="space-y-1">
          <div className="text-[11px] font-semibold text-[var(--text-secondary)]">{t('toolpath.model.diffs', { n: ready.pieces.length })}</div>
          {ready.pieces.slice(0, 8).map((pc, i) => {
            const size = pc.max.map((v, k) => fmtNumber(Math.round((v - pc.min[k]) * 10) / 10));
            const move = pc.move !== null ? path.moves[pc.move] : null;
            return (
              <button
                key={i}
                onClick={() => onFocus(pc.min.map((v, k) => (v + pc.max[k]) / 2) as Vec)}
                title={t(pc.kind === 'left' ? 'toolpath.model.leftHelp' : 'toolpath.model.cutHelp')}
                className="w-full flex items-start gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-[rgba(var(--ov),0.05)]"
              >
                <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: PIECE_COLORS[pc.kind] }} />
                <span className="flex-1 min-w-0">
                  <span className="font-semibold text-[var(--text-primary)]">{t(pc.kind === 'left' ? 'toolpath.model.left' : 'toolpath.model.cut')}</span>
                  <span className="text-[var(--text-secondary)]"> · {t('toolpath.model.size', { x: size[0], y: size[1], z: size[2] })} · {fmtNumber(Math.round(pc.mm3))} mm³</span>
                  {move && <span className="block font-mono text-[11px] text-[var(--text-tertiary)]">{t('toolpath.model.byLine', { n: move.line + 1, t: move.tool ?? '?' })}</span>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
