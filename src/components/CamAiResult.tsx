import { useState } from 'react';
import type { Coolant, CutEdit } from '../lib/cam/tools';
import { AlertTriangle, CheckCircle2, Clock, Download, Repeat, RotateCcw, Trash2 } from 'lucide-react';
import { useT } from '../i18n';
import { fmtNumber as fmt } from '../i18n/format';
import { downloadBlob } from '../lib/download';
import type { CamTool } from '../lib/cam/tools';
import type { CamSummary } from '../lib/cam/cam.worker';
import type { PhysicsIssue } from '../lib/cam/physics';
import { GOUGE_MM3 } from '../lib/cam/limits';

export type Setup = CamSummary['setups'][number];
export type Op = Setup['ops'][number];

export { GOUGE_MM3 };

/** Every check passed: like the model, nothing hit, nothing cut out of the part, held safely. */
export const passed = (r: CamSummary) => r.match >= 0.99 && r.collisions === 0 && r.gouge < GOUGE_MM3 && r.setups.every((s) => s.physics.ok && !s.ops.some((o) => o.unsafe));

const ZONE_COLOR: Record<string, string> = { contour: '#3b82f6', thinWall: '#a855f7', engraving: '#f59e0b' };
/** Pressure on the jaws, by its share of what the material takes: calm, watch, high. */
const pressureColor = (share: number) => (share < 0.5 ? '#22c55e' : share < 0.8 ? '#f59e0b' : '#ef4444');

/** 164 s -> "2:44". */
export const fmtTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;

export type ToolNamer = (o: { type: string; diameter: number; length: number }) => string;

/** A tool's name for the operator ("End mill Ø8, 40 mm long"). */
export function useToolName(): ToolNamer {
  const { t } = useT('remapper');
  return (o) => t('camAi.toolName', { name: t(`camAi.tools.${o.type}`, { defaultValue: o.type }), d: fmt(o.diameter, 2), l: fmt(o.length, 0) });
}

/** Why the program cannot go out yet, or that it can (one line, for the status). */
export function useVerdict(result: CamSummary, changed: number): { ok: boolean; text: string } {
  const { t } = useT('remapper');
  const ok = passed(result) && !changed;
  const unheld = result.setups.find((s) => !s.physics.ok);
  const unsafe = result.setups.some((s) => s.ops.some((o) => o.unsafe));
  const text = ok
    ? t('camAi.proven')
    : changed
      ? t('camAi.recalcFirst')
      : unsafe
        ? t('camAi.unsafe')
        : result.cales
          ? t('camAi.intoCale', { count: result.cales })
          : result.collisions
            ? t('camAi.collisions', { count: result.collisions })
            : result.gouge >= GOUGE_MM3
              ? t('camAi.gouge', { mm3: result.gouge })
              : unheld
                ? t('camAi.cannotHold', { side: unheld.side })
                : t('camAi.notProven');
  return { ok, text };
}

/**
 * The program as a whole (the browser's Program item): whether it can go out, its numbers, the
 * tools to load, what the machine lacks, the POM nests (each with its own program), notes.
 */
export function ProgramPanel({ result, machineName, changed, removed, onRestore }: { result: CamSummary; machineName: string; changed: number; removed: { key: string; label: string }[]; onRestore: (key: string) => void }) {
  const { t } = useT('remapper');
  const toolName = useToolName();
  const { ok, text } = useVerdict(result, changed);
  // Tools the program uses that are not in the machine yet, once each.
  const toLoad = [...new Map(result.setups.flatMap((s) => s.ops).filter((o) => !o.inMachine).map((o) => [o.code, o] as const)).values()];
  return (
    <div className="space-y-4">
      <p className={`flex items-start gap-2 text-xs font-medium ${ok ? 'text-[var(--green-text,#1fb257)]' : 'text-[var(--orange-text)]'}`}>
        {ok ? <CheckCircle2 size={16} className="shrink-0" /> : <AlertTriangle size={16} className="shrink-0" />}
        <span>{text}</span>
      </p>
      <dl className="grid grid-cols-2 gap-2">
        {[
          [t('camAi.match'), t('camAi.percent', { v: fmt(result.match * 100, 2) })],
          [t('camAi.time'), t('camAi.minutes', { v: fmt(result.minutes, 1) })],
          [t('camAi.toolChanges'), String(result.toolChanges)],
          [t('camAi.setups'), String(result.setups.length)],
          [t('camAi.overcut'), result.gouge < GOUGE_MM3 ? t('camAi.noOvercut') : t('camAi.overcutValue', { mm3: result.gouge })],
        ].map(([label, value]) => (
          <div key={label} className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] px-2.5 py-2">
            <dt className="text-[11px] text-[var(--text-tertiary)]">{label}</dt>
            <dd className="text-sm font-semibold text-[var(--text-primary)] tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {removed.length > 0 && (
        <div className="space-y-1.5">
          <h4 className="section-label">{t('camAi.removedTitle')}</h4>
          <ul className="space-y-1">
            {removed.map((r) => (
              <li key={r.key} className="flex items-center gap-1 text-xs">
                <span className="flex-1 min-w-0 break-words text-[var(--text-secondary)]">{r.label}</span>
                <button type="button" onClick={() => onRestore(r.key)} className="btn-secondary text-xs min-h-9 px-2.5 flex items-center gap-1">
                  <RotateCcw size={12} aria-hidden /> {t('camAi.restoreOp')}
                </button>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-[var(--text-tertiary)]">{t('camAi.removedNote')}</p>
        </div>
      )}
      <p className="text-xs text-[var(--text-tertiary)]">
        {t('camAi.sizes', { size: result.size.map((v) => fmt(v, 1)).join(' × '), raw: result.raw.map((v) => fmt(v, 1)).join(' × ') })}
      </p>
      {toLoad.length > 0 && (
        <div className="space-y-1.5">
          <h4 className="section-label">{t('camAi.toolsToLoad', { name: machineName })}</h4>
          <ul className="space-y-1">
            {toLoad.map((o) => (
              <li key={o.code} className="text-xs">
                <span className="font-medium text-[var(--text-primary)]">T{o.tool} · {toolName(o)}</span>
                <span className="block font-mono text-[11px] text-[var(--text-tertiary)]">{o.code}</span>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-[var(--text-tertiary)]">{t('camAi.swapHint')}</p>
        </div>
      )}
      {result.missing.length > 0 && (
        <div className="rounded-[var(--radius-md)] border border-[#f5b942]/40 bg-[#f5b942]/8 p-2.5 space-y-1.5">
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
      {result.nests.map((n, i) => (
        <div key={i} className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] p-2.5 space-y-2">
          <h4 className="text-xs font-semibold text-[var(--text-primary)]">{t('camAi.nestTitle', { side: n.side })}</h4>
          <p className="text-xs text-[var(--text-secondary)]">{t('camAi.nestSize', { size: n.size.map((v) => fmt(v, 1)).join(' × '), depth: fmt(n.depth, 1), count: n.screws })}</p>
          <button
            type="button"
            disabled={n.match < 0.99 || n.collisions > 0}
            onClick={() => downloadBlob(`NEST_${n.side.replace(/[+-]/, (c) => (c === '+' ? 'P' : 'M'))}.nc`, new Blob([n.code], { type: 'text/plain' }))}
            className="btn-secondary text-xs min-h-9 px-3 flex items-center gap-1.5"
          >
            <Download size={14} /> {t('camAi.nestDownload')}
          </button>
        </div>
      ))}
      {result.notes.length > 0 && (
        <ul className="text-xs text-[var(--text-secondary)] list-disc pl-4 space-y-0.5">
          {result.notes.map((n, i) => {
            const { key, ...v } = n;
            return <li key={i}>{t(`camAi.note.${key}`, v)}</li>;
          })}
        </ul>
      )}
    </div>
  );
}

/** A setup once made: its M0 text, the vise seen from above, how hard to clamp and any issue, the special zones. */
export function SetupPanel({ setup }: { setup: Setup }) {
  const { t } = useT('remapper');
  const s = setup;
  return (
    <div className="space-y-3 text-xs">
      <p className="flex items-center gap-1.5 text-[var(--text-secondary)] tabular-nums"><Clock size={13} aria-hidden />{t('camAi.setupTime', { time: fmtTime(s.ops.reduce((a, o) => a + o.seconds, 0)) })}</p>
      <div className="font-mono text-[11px] text-[var(--text-secondary)] space-y-0.5 break-words">
        {s.notes.map((n, k) => <div key={k}>M0 ({n})</div>)}
      </div>
      <ViseView setup={s} />
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
  );
}

const MILL_PURPOSES = new Set(['face', 'rough', 'rest', 'finish', 'contour', 'thinWalls', 'chamfer', 'engrave']);
const COOLANTS: Coolant[] = ['flood', 'air', 'off'];

/**
 * A tool in a setup: what it is, what it does there (from its operations), its cutting values to
 * change (the program is made again, and every check runs again, before it can go out), and a
 * stand-in when the operator does not have it.
 */
export function ToolCard({
  ops,
  name,
  draft,
  changed,
  busy,
  onEdit,
  removing,
  onRemove,
  focus,
  onFocus,
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
  /** Operations (keys) marked for removal: gone from the program the next time it is made. */
  removing: string[];
  onRemove: (op: Op, remove: boolean) => void;
  /** The operation whose path alone is shown in the view, and a way to pick one. */
  focus: string | null;
  onFocus: (key: string | null) => void;
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
      <ul className="space-y-1" aria-label={t('camAi.ops')}>
        {ops.map((o) => {
          const gone = removing.includes(o.key);
          const on = focus === o.key;
          return (
            <li key={o.key} className={`flex items-center gap-1 rounded-[6px] border ${on ? 'border-[var(--accent-primary)]/60 bg-[var(--accent-primary)]/8' : 'border-transparent'}`}>
              <button type="button" onClick={() => onFocus(on ? null : o.key)} aria-pressed={on} title={t('camAi.showOnlyThis')} className="no-glass flex-1 min-w-0 text-left px-2 py-1.5 min-h-9">
                <span className={`block ${gone ? 'line-through text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]'}`}>{t(`camAi.purpose.${o.purpose}`)}</span>
                <span className="flex flex-wrap items-center gap-x-2 text-[11px] text-[var(--text-tertiary)] tabular-nums">
                  <span className="inline-flex items-center gap-1"><Clock size={11} aria-hidden />{fmtTime(o.seconds)}</span>
                  {o.zMin < 0 && <span>{t('camAi.downTo', { z: fmt(o.zMin, 2) })}</span>}
                  {!o.learned && <span>{t('camAi.default')}</span>}
                </span>
              </button>
              <button
                type="button"
                onClick={() => onRemove(o, !gone)}
                disabled={busy}
                aria-label={t(gone ? 'camAi.keepOp' : 'camAi.removeOp', { name: t(`camAi.purpose.${o.purpose}`) })}
                title={t(gone ? 'camAi.keepOp' : 'camAi.removeOp', { name: t(`camAi.purpose.${o.purpose}`) })}
                className="no-glass shrink-0 grid place-items-center w-9 h-9 rounded-[6px] text-[var(--text-secondary)] hover:bg-[rgba(var(--ov),0.08)] hover:text-[var(--text-primary)] disabled:opacity-40"
              >
                {gone ? <RotateCcw size={14} aria-hidden /> : <Trash2 size={14} aria-hidden />}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="text-[11px] text-[var(--text-tertiary)] tabular-nums">{t('camAi.toolTime', { time: fmtTime(ops.reduce((a, o) => a + o.seconds, 0)) })}{deepest < 0 ? ` · ${t('camAi.deepest', { z: fmt(deepest, 2) })}` : ''}</p>
      <div className="grid grid-cols-2 gap-2">
        {field('rpm', 's', 100)}
        {field('feed', 'f', 10)}
        {mill && field('ae', 'ae', 0.1)}
        {mill && field('ap', 'ap', 0.1)}
        <label className="space-y-1 min-w-0 col-span-2">
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
export function ViseView({ setup }: { setup: Setup }) {
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
