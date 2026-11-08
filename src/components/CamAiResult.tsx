import { useState } from 'react';
import type { Coolant, CutEdit } from '../lib/cam/tools';
import { AlertTriangle, CheckCircle2, ChevronDown, Download, RefreshCw, Repeat, Route, Send } from 'lucide-react';
import { useT } from '../i18n';
import { fmtNumber as fmt } from '../i18n/format';
import { downloadBlob } from '../lib/download';
import { alternatives, type CamTool } from '../lib/cam/tools';
import type { CamSummary } from '../lib/cam/cam.worker';
import type { PhysicsIssue } from '../lib/cam/physics';
import type { Tool } from '../types';

type Setup = CamSummary['setups'][number];
type Op = Setup['ops'][number];

/** Bigger than this is a gouge (mm³): smaller pieces are the simulation's grid. */
export const GOUGE_MM3 = 20;

/** Every check passed: like the model, nothing hit, nothing cut out of the part, held safely. */
export const passed = (r: CamSummary) => r.match >= 0.99 && r.collisions === 0 && r.gouge < GOUGE_MM3 && r.setups.every((s) => s.physics.ok && !s.ops.some((o) => o.unsafe));

const ZONE_COLOR: Record<string, string> = { contour: '#3b82f6', thinWall: '#a855f7', engraving: '#f59e0b' };
/** Pressure on the jaws, by its share of what the material takes: calm, watch, high. */
const pressureColor = (share: number) => (share < 0.5 ? '#22c55e' : share < 0.8 ? '#f59e0b' : '#ef4444');

/**
 * What CAM AI made: whether every check passed, the tools to load (with a stand-in for one the
 * operator does not have), each setup (its M0 text, how hard to clamp, the vise seen from above
 * with the jaw pressure and the special zones, the operations with their purpose), the POM nests.
 */
export default function CamAiResult({
  result,
  machineName,
  machineTools,
  material,
  exclude,
  cuts,
  busy,
  onRecalc,
  onSwap,
  onView,
  onDownload,
  onSend,
}: {
  result: CamSummary;
  machineName: string;
  machineTools: Tool[];
  /** The material the templates are taken for (stand-ins come from the same family). */
  material: string;
  exclude: string[];
  /** The operator's cutting values the program was made with, per tool code. */
  cuts: Record<string, CutEdit>;
  busy: boolean;
  /** Make the program again with these values (every check runs again). */
  onRecalc: (cuts: Record<string, CutEdit>) => void;
  onSwap: (code: string, standIn: string) => void;
  onView: () => void;
  onDownload: () => void;
  onSend: () => void;
}) {
  const { t } = useT('remapper');
  // Values typed and not yet in the program: the program must be made again before it goes out.
  const [draft, setDraft] = useState<Record<string, CutEdit>>(cuts);
  const changed = Object.keys({ ...draft, ...cuts }).filter((k) => JSON.stringify(draft[k] ?? {}) !== JSON.stringify(cuts[k] ?? {}));
  const edit = (code: string, v: CutEdit) => setDraft((d) => ({ ...d, [code]: { ...d[code], ...v } }));
  const ok = passed(result) && !changed.length;
  const unheld = result.setups.find((s) => !s.physics.ok);
  const toolName = (o: { type: string; diameter: number; length: number }) =>
    t('camAi.toolName', { name: t(`camAi.tools.${o.type}`, { defaultValue: o.type }), d: fmt(o.diameter, 2), l: fmt(o.length, 0) });
  // Tools the program uses that are not in the machine yet, once each.
  const toLoad = [...new Map(result.setups.flatMap((s) => s.ops).filter((o) => !o.inMachine).map((o) => [o.code, o] as const)).values()];

  return (
    <section className="glass-panel rounded-[var(--radius-lg)] p-5 space-y-5" aria-labelledby="cam-result">
      <h3 id="cam-result" className="sr-only">{t('camAi.result')}</h3>
      <div className={`flex items-start gap-2 text-sm font-medium ${ok ? 'text-[var(--green-text,#1fb257)]' : 'text-[var(--orange-text)]'}`} role="status">
        {ok ? <CheckCircle2 size={18} className="shrink-0" /> : <AlertTriangle size={18} className="shrink-0" />}
        <span>
          {ok
            ? t('camAi.proven')
            : changed.length
              ? t('camAi.recalcFirst')
              : result.cales
              ? t('camAi.intoCale', { count: result.cales })
              : result.collisions
                ? t('camAi.collisions', { count: result.collisions })
                : result.gouge >= GOUGE_MM3
                  ? t('camAi.gouge', { mm3: result.gouge })
                  : unheld
                    ? t('camAi.cannotHold', { side: unheld.side })
                    : t('camAi.notProven')}
        </span>
      </div>

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

      {toLoad.length > 0 && (
        <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] p-3 space-y-2">
          <h4 className="text-xs font-semibold text-[var(--text-primary)]">{t('camAi.toolsToLoad', { name: machineName })}</h4>
          <ul className="space-y-2">
            {toLoad.map((o) => (
              <li key={o.code} className="text-xs flex flex-wrap gap-2">
                <span className="font-medium text-[var(--text-primary)]">T{o.tool} · {toolName(o)}</span>
                <span className="font-mono text-[var(--text-tertiary)]">{o.code}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-[var(--text-tertiary)]">{t('camAi.swapHint')}</p>
        </div>
      )}

      {result.missing.length > 0 && (
        <div className="rounded-[var(--radius-md)] border border-[#f5b942]/40 bg-[#f5b942]/8 p-3 space-y-2">
          <h4 className="text-xs font-semibold text-[var(--orange-text)] flex items-center gap-1.5">
            <AlertTriangle size={14} /> {t('camAi.missing', { name: machineName })}
          </h4>
          <ul className="text-xs text-[var(--text-secondary)] space-y-1">
            {result.missing.map((n, i) => {
              const { key, ...v } = n.why;
              return (
                <li key={i}>
                  <span className="font-medium text-[var(--text-primary)]">
                    {t(`common:category.${n.category}`, { defaultValue: n.category })} Ø{fmt(n.diameter, 2)}
                    {n.minLength > 0 && `, ${t('camAi.minLength', { mm: n.minLength })}`}
                  </span>{' '}
                  · {t(`camAi.why.${key}`, v)}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="space-y-3">
        {result.setups.map((s, i) => {
          // The setup's tools, each once, with what it does there.
          const byTool = [...new Map(s.ops.map((o) => [o.code, s.ops.filter((x) => x.code === o.code)] as const)).values()];
          return (
            <details key={i} open={i === 0} className="group rounded-[var(--radius-md)] border border-[var(--border-subtle)]">
              <summary className="flex items-center gap-3 px-3 min-h-12 cursor-pointer list-none select-none">
                <ChevronDown size={16} className="shrink-0 text-[var(--text-tertiary)] transition-transform group-open:rotate-0 -rotate-90" aria-hidden />
                <span className="text-xs font-semibold text-[var(--text-primary)]">{t('camAi.setupStep', { n: i + 1, op: (i + 1) * 10 })}</span>
                <span className="font-mono text-xs text-[var(--text-secondary)]">{s.side}</span>
                <span className="text-xs text-[var(--text-tertiary)] ml-auto">{t('camAi.toolCount', { count: byTool.length })}</span>
                {!s.physics.ok || s.ops.some((o) => o.unsafe) ? <AlertTriangle size={14} className="text-[var(--orange-text)]" aria-label={t('camAi.setupIssue')} /> : <CheckCircle2 size={14} className="text-[var(--green-text,#1fb257)]" aria-hidden />}
              </summary>
              <div className="px-3 pb-3 space-y-3">
                <div className="font-mono text-xs text-[var(--text-secondary)] space-y-0.5">
                  {s.notes.map((n, k) => <div key={k}>M0 ({n})</div>)}
                </div>
                <div className="grid md:grid-cols-[minmax(0,15rem)_1fr] gap-3 items-start">
                  <ViseView setup={s} />
                  <div className="space-y-2 text-xs">
                    <p className={s.physics.ok ? 'text-[var(--text-secondary)]' : 'text-[var(--orange-text)]'}>
                      {s.physics.issues.some((x) => x.key === 'nest')
                        ? t('camAi.inNest', { count: (s.physics.issues.find((x) => x.key === 'nest') as { screws: number }).screws })
                        : t('camAi.clamp', { kn: fmt(s.physics.clamp.use / 1000, 1), level: t(`camAi.clampLevel.${s.physics.clamp.use < 5000 ? 'light' : s.physics.clamp.use < 15000 ? 'normal' : 'firm'}`) })}
                      {s.physics.pressureShare > 0 && ` · ${t('camAi.pressure', { v: fmt(s.physics.pressureShare * 100, 0) })}`}
                    </p>
                    {s.physics.issues.filter((x) => x.key !== 'nest').length > 0 && (
                      <ul className="list-disc pl-4 text-[var(--orange-text)] space-y-0.5">
                        {s.physics.issues
                          .filter((x) => x.key !== 'nest')
                          .map((x, k) => {
                            const { key, ...v } = x as PhysicsIssue & Record<string, number>;
                            return <li key={k}>{t(`camAi.issue.${key}`, { ...v, v: 'share' in v ? fmt(v.share * 100, 0) : '' })}</li>;
                          })}
                      </ul>
                    )}
                    {s.zones.length > 0 && (
                      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[var(--text-secondary)]">
                        <span className="text-[var(--text-tertiary)]">{t('camAi.zonesTitle')}:</span>
                        {s.zones.map((z, k) => (
                          <span key={k} className="inline-flex items-center gap-1">
                            <span aria-hidden className="w-2.5 h-2.5 rounded-sm" style={{ background: ZONE_COLOR[z.kind] }} />
                            {t(`camAi.zone.${z.kind}`)}
                          </span>
                        ))}
                      </p>
                    )}
                  </div>
                </div>
                <p className="text-[11px] text-[var(--text-tertiary)]">{t('camAi.everywhere')}</p>
                <ul className="space-y-2" aria-label={t('camAi.ops')}>
                  {byTool.map((ops) => (
                    <ToolCard
                      key={ops[0].code}
                      ops={ops}
                      name={toolName(ops[0])}
                      draft={draft[ops[0].code] ?? {}}
                      changed={changed.includes(ops[0].code)}
                      busy={busy}
                      onEdit={(v) => edit(ops[0].code, v)}
                      options={alternatives(material, machineTools, ops[0].code, exclude)}
                      toolName={toolName}
                      onSwap={onSwap}
                    />
                  ))}
                </ul>
              </div>
            </details>
          );
        })}
      </div>
      {result.setups.some((s) => s.ops.some((o) => !o.learned)) && <p className="text-xs text-[var(--text-tertiary)]">* {t('camAi.default')}</p>}

      {result.nests.map((n, i) => (
        <div key={i} className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] p-3 space-y-2">
          <h4 className="text-xs font-semibold text-[var(--text-primary)]">{t('camAi.nestTitle', { side: n.side })}</h4>
          <p className="text-xs text-[var(--text-secondary)]">{t('camAi.nestSize', { size: n.size.map((v) => fmt(v, 1)).join(' × '), depth: fmt(n.depth, 1), count: n.screws })}</p>
          <button
            type="button"
            disabled={n.match < 0.99 || n.collisions > 0}
            onClick={() => downloadBlob(`NEST_${n.side.replace(/[+-]/, (c) => (c === '+' ? 'P' : 'M'))}.nc`, new Blob([n.code], { type: 'text/plain' }))}
            className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5"
          >
            <Download size={14} /> {t('camAi.nestDownload')}
          </button>
        </div>
      ))}

      {result.notes.length > 0 && (
        <ul className="text-xs text-[var(--text-secondary)] list-disc pl-5 space-y-0.5">
          {result.notes.map((n, i) => {
            const { key, ...v } = n;
            return <li key={i}>{t(`camAi.note.${key}`, v)}</li>;
          })}
        </ul>
      )}

      {changed.length > 0 && (
        <div className="sticky bottom-3 z-10 flex flex-wrap items-center gap-3 rounded-[var(--radius-md)] border border-[var(--accent-primary)]/40 bg-[var(--bg-panel)]/95 backdrop-blur p-3 shadow-lg" role="status">
          <span className="text-xs text-[var(--text-primary)] flex-1 min-w-48">{t('camAi.recalcNeeded', { count: changed.length })}</span>
          <button type="button" onClick={() => setDraft(cuts)} disabled={busy} className="btn-secondary text-xs min-h-11 px-3">
            {t('camAi.discard')}
          </button>
          <button type="button" onClick={() => onRecalc(draft)} disabled={busy} className="btn-primary text-xs min-h-11 px-4 flex items-center gap-1.5">
            <RefreshCw size={14} className={busy ? 'animate-spin motion-reduce:animate-none' : ''} /> {t('camAi.recalc')}
          </button>
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onView} className="btn-secondary text-xs py-2 px-4 flex items-center gap-1.5">
          <Route size={14} /> {t('camAi.view')}
        </button>
        <button type="button" onClick={onDownload} disabled={!ok} className="btn-secondary text-xs py-2 px-4 flex items-center gap-1.5" title={ok ? undefined : t('camAi.locked')}>
          <Download size={14} /> {t('camAi.download')}
        </button>
        <button type="button" onClick={onSend} disabled={!ok} className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5" title={ok ? undefined : t('camAi.locked')}>
          <Send size={14} /> {t('camAi.send')}
        </button>
      </div>
      {!ok && <p className="text-xs text-[var(--text-tertiary)] text-right">{t('camAi.locked')}</p>}
    </section>
  );
}

const MILL_PURPOSES = new Set(['face', 'rough', 'rest', 'finish', 'contour', 'thinWalls', 'chamfer', 'engrave']);
const COOLANTS: Coolant[] = ['flood', 'air', 'off'];

/**
 * A tool in a setup: what it is, what it does there (from its operations), its cutting values to
 * change (the program is made again, and every check runs again, before it can go out), and a
 * stand-in when the operator does not have it.
 */
function ToolCard({
  ops,
  name,
  draft,
  changed,
  busy,
  onEdit,
  options,
  toolName,
  onSwap,
}: {
  ops: Op[];
  name: string;
  draft: CutEdit;
  changed: boolean;
  busy: boolean;
  onEdit: (v: CutEdit) => void;
  options: CamTool[];
  toolName: (o: { type: string; diameter: number; length: number }) => string;
  onSwap: (code: string, standIn: string) => void;
}) {
  const { t } = useT('remapper');
  const [asking, setAsking] = useState(false);
  const [pick, setPick] = useState(options[0]?.code ?? '');
  const op = ops[0];
  const mill = ops.some((o) => MILL_PURPOSES.has(o.purpose));
  const deepest = Math.min(...ops.map((o) => o.zMin));
  const purposes = [...new Set(ops.map((o) => o.purpose))];
  const field = (key: 'rpm' | 'feed' | 'ae' | 'ap', k: 's' | 'f' | 'ae' | 'ap', step: number) => (
    <label className="space-y-1 min-w-0">
      <span className="section-label block">{t(`camAi.cut.${key}`)}</span>
      <input
        className="aurora-input w-full min-w-0 text-xs px-2 tabular-nums"
        type="number"
        min={0}
        step={step}
        inputMode="decimal"
        disabled={busy}
        value={draft[k] ?? op[k]}
        onChange={(e) => onEdit({ [k]: e.target.value === '' ? undefined : Number(e.target.value) })}
      />
    </label>
  );
  return (
    <li className={`rounded-[var(--radius-md)] border p-3 space-y-2.5 text-xs ${op.unsafe ? 'border-[#ef4444]/50' : changed ? 'border-[var(--accent-primary)]/50' : 'border-[var(--border-subtle)]'}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-semibold text-[var(--text-primary)]">T{op.tool} – {name}</span>
        <span className={`text-[10px] py-0.5 px-1.5 ${op.inMachine ? 'badge-neutral' : 'badge-warning'}`}>{t(op.inMachine ? 'camAi.inMachine' : 'camAi.toLoad')}</span>
        {changed && <span className="badge-neutral text-[10px] py-0.5 px-1.5 text-[var(--blue-text)]">{t('camAi.changedBadge')}</span>}
      </div>
      <p className="text-[var(--text-secondary)]">
        {purposes.map((p) => t(`camAi.purpose.${p}`)).join(', ')}
        {deepest < 0 && ` ${t('camAi.downTo', { z: fmt(deepest, 2) })}`}
        {!op.learned && ` · ${t('camAi.default')}`}
      </p>
      <div className={`grid gap-2 ${mill ? 'grid-cols-2 md:grid-cols-5' : 'grid-cols-3 md:grid-cols-5'}`}>
        {field('rpm', 's', 100)}
        {field('feed', 'f', 10)}
        {mill && field('ae', 'ae', 0.1)}
        {mill && field('ap', 'ap', 0.1)}
        <label className="space-y-1 min-w-0">
          <span className="section-label block">{t('camAi.cut.coolant')}</span>
          <select className="aurora-input w-full min-w-0 text-xs px-2 cursor-pointer" disabled={busy} value={draft.coolant ?? op.coolant} onChange={(e) => onEdit({ coolant: e.target.value as Coolant })}>
            {COOLANTS.map((c) => (
              <option key={c} value={c} className="bg-[var(--bg-panel)]">{t(`camAi.coolant.${c}`)}</option>
            ))}
          </select>
        </label>
      </div>
      {op.unsafe && (
        <p className="flex items-start gap-1.5 text-[var(--orange-text)]" role="alert">
          <AlertTriangle size={13} className="shrink-0 mt-px" /> {t('camAi.unsafe')}
        </p>
      )}
      {!asking ? (
        <button type="button" onClick={() => setAsking(true)} disabled={busy} className="btn-secondary text-xs min-h-9 px-2.5 flex items-center gap-1">
          <Repeat size={12} /> {t('camAi.swapTool')}
        </button>
      ) : options.length ? (
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2">
            <span className="text-[var(--text-secondary)]">{t('camAi.standIn')}</span>
            <select className="aurora-input text-xs cursor-pointer" value={pick} onChange={(e) => setPick(e.target.value)}>
              {options.map((o) => (
                <option key={o.code} value={o.code} className="bg-[var(--bg-panel)]">
                  {toolName(o)}
                  {o.inMachine ? ` · T${o.number}` : ''}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => onSwap(op.code, pick)} disabled={busy} className="btn-primary text-xs min-h-9 px-3">
            {t('camAi.again')}
          </button>
          <button type="button" onClick={() => setAsking(false)} className="btn-secondary text-xs min-h-9 px-3">
            {t('camAi.cancel')}
          </button>
        </div>
      ) : (
        <p className="text-[var(--orange-text)]">{t('camAi.noStandIn')}</p>
      )}
    </li>
  );
}

/**
 * The setup seen from above: the jaws along X (the fixed one at the back, the stop on the left),
 * the part held between them, where the jaws touch it coloured by how hard they press, and the
 * special zones' outlines.
 */
function ViseView({ setup }: { setup: Setup }) {
  const { t } = useT('remapper');
  const [x0, y0, x1, y1] = setup.box;
  const w = x1 - x0;
  const h = y1 - y0;
  const pad = Math.max(w, h) * 0.18 + 4;
  const jaw = Math.max(3, Math.min(w, h) * 0.12);
  const contact = setup.contact?.jaws ?? 0;
  const colour = pressureColor(setup.physics.pressureShare);
  const nested = setup.physics.issues.some((x) => x.key === 'nest');
  return (
    <svg viewBox={`${x0 - pad} ${-(y1 + pad)} ${w + 2 * pad} ${h + 2 * pad}`} className="w-full h-auto max-h-44 rounded-[var(--radius-md)] bg-[rgba(var(--ov),0.04)]" role="img" aria-label={t('camAi.visePic')}>
      {/* The part's Y grows away from the operator: drawn with the back up. */}
      <g transform="scale(1,-1)">
        {!nested && (
          <>
            <rect x={x0 - jaw} y={y1} width={w + 2 * jaw} height={jaw} fill="#64748b" opacity={0.55} />
            <rect x={x0 - jaw} y={y0 - jaw} width={w + 2 * jaw} height={jaw} fill="#64748b" opacity={0.55} />
            <rect x={x0 - jaw} y={y0 - jaw} width={jaw * 0.6} height={h + 2 * jaw} fill="#475569" opacity={0.7} />
          </>
        )}
        <rect x={x0} y={y0} width={w} height={h} fill="#94a3b8" fillOpacity={0.35} stroke="#94a3b8" strokeWidth={Math.max(w, h) / 250} />
        {!nested && contact > 0 && (
          <>
            <rect x={x0} y={y1 - jaw * 0.35} width={Math.min(w, contact)} height={jaw * 0.35} fill={colour} />
            <rect x={x0} y={y0} width={Math.min(w, contact)} height={jaw * 0.35} fill={colour} />
          </>
        )}
        {setup.zones.map((z, k) =>
          z.loops.map((l, j) => (
            <polygon key={`${k}-${j}`} points={l.map((p) => `${p[0]},${p[1]}`).join(' ')} fill={ZONE_COLOR[z.kind]} fillOpacity={0.25} stroke={ZONE_COLOR[z.kind]} strokeWidth={Math.max(w, h) / 200} />
          )),
        )}
      </g>
    </svg>
  );
}
