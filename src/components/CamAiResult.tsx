import { useState, type ReactNode } from 'react';
import type { CutEdit } from '../lib/cam/tools';
import { editInRange, type OpEdit } from '../lib/cam/opEdit';
import { IconAlertTriangle as AlertTriangle, IconCircleCheck as CheckCircle2, IconClock as Clock, IconDownload as Download, IconRepeat as Repeat, IconRotate as RotateCcw, IconTrash as Trash2 } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { fmtNumber as fmt } from '../i18n/format';
import { downloadBlob } from '../lib/download';
import { forMachine } from '../lib/cam/export';
import type { CamTool } from '../lib/cam/tools';
import type { CamSummary } from '../lib/cam/cam.worker';
import type { Purpose } from '../lib/cam/program';
import type { PhysicsIssue } from '../lib/cam/physics';
import { GOUGE_MM3 } from '../lib/cam/limits';
import ToolSize from './ToolSize';

export type Setup = CamSummary['setups'][number];
export type Op = Setup['ops'][number];

export { GOUGE_MM3 };

/** Every check passed: like the model, nothing hit, nothing cut out of the part, held safely. */
// The designer's parallels or jaw rest not used as asked (clampRefused, clampAsk, jawRefused): not the program they asked
// for. A cut within 0.5 mm of the vise floor (floorHit): the simulation has none.
/** Nothing in the machine's or the vise's way: never relaxed. */
export const safeButHold = (r: CamSummary) => r.collisions === 0 && r.cales === 0 && r.setups.every((s) => s.physics.ok && !s.ops.some((o) => o.unsafe)) && !r.notes.some((n) => n.key === 'clampRefused' || n.key === 'clampAsk' || n.key === 'jawRefused' || n.key === 'floorHit' || n.key === 'orderLocked');
export const safe = (r: CamSummary) => safeButHold(r) && !r.misplaced;
/** The part as the model: may be accepted as it is after changes by hand (`accepted`, an explicit tick). */
export const alike = (r: CamSummary) => r.match >= 0.99 && r.sized && r.gouge < GOUGE_MM3;
/**
 * Accepted (you): a part changed by hand as it is, also where the vise then holds it off where a later clamping's zero
 * assumes (a tool of another Ø changed by hand: the operator knows why). Nothing that hits the machine is ever accepted.
 */
export const passed = (r: CamSummary, accepted = false) => safeButHold(r) && (accepted || (!r.misplaced && alike(r)));
/** A tool number the machine does not take: a Haas takes T and H 1-200 only (the hole rules); a FANUC keeps its own pointeurs. */
export const badToolNumber = (r: CamSummary, brand: string | undefined) => (brand === 'HAAS' ? r.setups.flatMap((s) => s.ops).find((o) => o.tool < 1 || o.tool > 200)?.tool : undefined);

const ZONE_COLOR: Record<string, string> = { contour: '#3b82f6', thinWall: '#a855f7', engraving: '#f59e0b' };
/** Pressure on the jaws, by its share of what the material takes: calm, watch, high. */
const pressureColor = (share: number) => (share < 0.5 ? '#22c55e' : share < 0.8 ? '#f59e0b' : '#ef4444');

/** 164 s -> "2:44". */
/**
 * What a cutting-value field shows: the text typed while it is still the value kept (empty: CAM AI's, the placeholder),
 * else the value kept (typed, or put back by Undo), else CAM AI's own.
 */
export const cutText = (typed: string | undefined, kept: number | undefined, made: number) => (typed !== undefined && (typed === '' ? kept === undefined : Number(typed) === kept) ? typed : String(kept ?? made));

export const fmtTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
/** The turns a clamping's note writes from the one before (fixTurns' turnPhrase), each as "180° X", in the note's order. */
export const writtenTurns = (note: string) => [...note.matchAll(/(\d+)\s*GRAD\s*UM\s*([XYZ])/g)].map((m) => `${m[1]}° ${m[2]}`);

export type ToolNamer = (o: { type: string; diameter: number; length: number }) => string;

/** A tool's name for the operator as text, where badges cannot go (a list's options): "End mill · Ø 8 mm · length 40 mm". */
export function useToolName(): ToolNamer {
  const { t } = useTranslation(['cam', 'remapper', 'common']);
  return (o) => t('camAi.toolName', { name: t(`camAi.tools.${o.type}`, { defaultValue: o.type }), d: fmt(o.diameter, 2), l: fmt(o.length, 0) });
}

/** Why the program cannot go out yet, or that it can (one line, for the status). */
/** A tool's name, then its Ø and length as badges (ToolSize). */
export function ToolLabel({ o }: { o: { type: string; diameter: number; length: number } }) {
  const { t } = useTranslation('cam');
  return (
    <span className="flex-1 min-w-0 flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="truncate">{t(`camAi.tools.${o.type}`, { defaultValue: o.type })}</span>
      <ToolSize d={o.diameter} l={o.length} />
    </span>
  );
}

export function useVerdict(result: CamSummary, changed: number, accepted = false): { ok: boolean; text: string } {
  const { t } = useTranslation(['cam', 'remapper', 'common']);
  const ok = passed(result, accepted) && !changed;
  const unheld = result.setups.find((s) => !s.physics.ok);
  const unsafe = result.setups.some((s) => s.ops.some((o) => o.unsafe));
  // An operation dragged before one it was made to follow: why it is locked (it is also marked unsafe).
  const orderNote = result.notes.find((n) => n.key === 'orderLocked');
  // The designer's parallels not used as asked: why it stays locked.
  const clampNote = result.notes.find((n) => n.key === 'clampRefused' || n.key === 'clampAsk' || n.key === 'jawRefused' || n.key === 'floorHit');
  const text = ok
    ? accepted && (!alike(result) || result.misplaced)
      ? [t('camAi.opEdit.acceptedText'), result.misplaced ? t('camAi.opEdit.acceptedHold', { count: result.misplaced }) : ''].filter(Boolean).join(' ')
      : t('camAi.proven')
    : changed
      ? t('camAi.recalcFirst')
      : orderNote
        ? t('camAi.note.orderLocked', { setup: orderNote.setup, used: orderNote.used, d: orderNote.d })
        : unsafe
        ? t('camAi.unsafe')
        : result.cales
          ? t('camAi.intoCale', { count: result.cales })
          : result.stops
            ? [t('camAi.intoStop', { count: result.stops }), result.collisions > result.stops ? t('camAi.collisions', { count: result.collisions - result.stops }) : ''].filter(Boolean).join(' ')
            : result.collisions
            ? t('camAi.collisions', { count: result.collisions })
            : result.misplaced
              ? t('camAi.misplaced', { count: result.misplaced })
              : !result.sized
              ? t('camAi.notSized')
              : result.gouge >= GOUGE_MM3
              ? t('camAi.gouge', { mm3: result.gouge })
              : unheld
                ? t(unheld.physics.issues.some((i) => i.key === 'faceAtJaws') ? 'camAi.faceAtJaws' : 'camAi.cannotHold', { side: unheld.side })
                : clampNote
                  ? t(`camAi.note.${clampNote.key as 'clampAsk' | 'clampRefused' | 'jawRefused' | 'floorHit'}`, { setup: clampNote.setup, cale: clampNote.cale })
                  : t('camAi.notProven');
  return { ok, text };
}

/**
 * The program as a whole (the browser's Program item): whether it can go out, its numbers, the
 * tools to load, what the machine lacks, the POM nests (each with its own program), notes.
 */
export function ProgramPanel({
  result,
  machineName,
  machineId,
  changed,
  removed,
  onRestore,
  shown,
  onShow,
}: {
  result: CamSummary;
  machineName: string;
  machineId: string;
  changed: number;
  removed: { key: string; label: string }[];
  onRestore: (key: string) => void;
  /** The removed operation whose path is highlighted in the view, and a way to pick one (you, Beta 2). */
  shown?: string | null;
  onShow?: (key: string | null) => void;
}) {
  const { t } = useTranslation(['cam', 'remapper', 'common']);
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
            <dt className="text-xs text-[var(--text-secondary)]">{label}</dt>
            <dd className="text-sm font-semibold text-[var(--text-primary)] tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {removed.length > 0 && (
        <div className="space-y-1.5">
          <h4 className="section-label">{t('camAi.removedTitle')}</h4>
          <ul className="space-y-1">
            {removed.map((r) => (
              <li key={r.key} className={`flex items-center gap-1 text-xs rounded-[6px] border ${shown === r.key ? 'border-[#ff4d6d]/60 bg-[#ff4d6d]/8' : 'border-transparent'}`}>
                <button type="button" onClick={() => onShow?.(shown === r.key ? null : r.key)} aria-pressed={shown === r.key} title={t('camAi.showRemoved')} className="no-glass flex-1 min-w-0 text-left px-2 py-1.5 min-h-9 break-words line-through text-[var(--text-secondary)]">
                  {r.label}
                </button>
                <button type="button" onClick={() => onRestore(r.key)} className="btn-secondary text-xs min-h-9 px-2.5 flex items-center gap-1">
                  <RotateCcw size={12} aria-hidden /> {t('camAi.restoreOp')}
                </button>
              </li>
            ))}
          </ul>
          <p className="text-xs text-[var(--text-secondary)]">{t('camAi.removedNote')}</p>
        </div>
      )}
      <p className="text-xs text-[var(--text-secondary)]">
        {t('camAi.sizes', { size: result.size.map((v) => fmt(v, 1)).join(' × '), raw: result.raw.map((v) => fmt(v, 1)).join(' × ') })}
      </p>
      {toLoad.length > 0 && (
        <div className="space-y-1.5">
          <h4 className="section-label">{t('camAi.toolsToLoad', { name: machineName })}</h4>
          <ul className="space-y-1">
            {toLoad.map((o) => (
              <li key={o.code} className="text-xs">
                <span className="flex items-center gap-2 font-medium text-[var(--text-primary)]"><span className="font-mono shrink-0">T{o.tool}</span><ToolLabel o={o} /></span>
                <span className="block font-mono text-xs text-[var(--text-secondary)]">{o.code}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-[var(--text-secondary)]">{t('camAi.swapHint')}</p>
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
            onClick={() => {
              // As the machine gets it, like the program's own Download (forMachine); a nest is POM.
              const name = `NEST_${n.side.replace(/[+-]/, (c) => (c === '+' ? 'P' : 'M'))}.nc`;
              downloadBlob(name, new Blob([forMachine(n.code, machineId, name, 'POM')], { type: 'text/plain' }));
            }}
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
  const { t } = useTranslation(['cam', 'remapper', 'common']);
  const s = setup;
  return (
    <div className="space-y-3 text-xs">
      <p className="flex items-center gap-1.5 text-[var(--text-secondary)] tabular-nums"><Clock size={13} aria-hidden />{t('camAi.setupTime', { time: fmtTime(s.ops.reduce((a, o) => a + o.seconds, 0)) })}</p>
      <div className="font-mono text-xs text-[var(--text-secondary)] space-y-0.5 break-words">
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
          <span className="text-[var(--text-secondary)]">{t('camAi.zonesTitle')}:</span>
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

const MILL_PURPOSES = new Set(['face', 'outline', 'rough', 'rest', 'finish', 'contour', 'thinWalls', 'chamfer', 'engrave']);

/**
 * A tool in a setup: what it is, what it does there (from its operations), its cutting values to
 * change (the program is made again, and every check runs again, before it can go out), and a
 * stand-in when the operator does not have it.
 */
export function ToolCard({
  aside,
  ask = false,
  ops,
  draft,
  changed,
  busy,
  onEdit,
  removing,
  onRemove,
  gone = [],
  onRestore,
  focus,
  onFocus,
  options,
  toolName,
  onSwap,
  shop = [],
  onUse,
  hits = 0,
  opEdits = {},
  checking = false,
  onOpEdit,
}: {
  /** Beside its name: the inspector's own button (fold it away). */
  aside?: ReactNode;
  /** Open on changing the tool (a right click on it). */
  ask?: boolean;
  ops: Op[];
  draft: CutEdit;
  changed: boolean;
  busy: boolean;
  onEdit: (v: CutEdit) => void;
  /** Operations (keys) marked for removal: gone from the program the next time it is made. */
  removing: string[];
  onRemove: (op: Op, remove: boolean) => void;
  /** This tool's operations deleted and no longer in the program shown (you: crossed out, never gone), and restoring one. */
  gone?: { key: string; purpose: Purpose; still: boolean }[];
  onRestore?: (key: string) => void;
  /** The operation whose path alone is shown in the view, and a way to pick one. */
  focus: string | null;
  onFocus: (key: string | null) => void;
  options: CamTool[];
  toolName: (o: { type: string; diameter: number; length: number }) => string;
  onSwap: (code: string, standIn: string) => void;
  /** Every tool of the shop (machine, then tool database), for a swap of any kind (item 6). */
  shop?: CamTool[];
  /** This tool's operations given another tool on the same paths (null: back to CAM AI's). */
  onUse?: (tool: { d: number; l: number; code?: string } | null) => void;
  /** Hits into the jaws, the stop or the holder in the program as checked now. */
  hits?: number;
  /** Changes by hand to the operations (by key), the one being applied, and how to apply one (null: undo it). */
  opEdits?: Record<string, OpEdit>;
  checking?: boolean;
  onOpEdit?: (key: string, e: OpEdit | null) => void;
}) {
  const { t } = useTranslation(['cam', 'remapper', 'common']);
  const [asking, setAsking] = useState(ask);
  const [pick, setPick] = useState(options[0]?.code ?? '');
  const [typed, setTyped] = useState<{ d: string; l: string }>({ d: '', l: '' });
  // The cutting values as typed (an emptied field stays empty, never back to CAM AI's value under the caret).
  const [typedCut, setTypedCut] = useState<Partial<Record<'s' | 'f' | 'ae' | 'ap', string>>>({});
  const op = ops[0];
  // The tool picked to swap in, and what differs from the one it replaces (warned, never refused).
  const TYPED = '__typed';
  const chosenTool = pick === TYPED ? null : (options.find((o) => o.code === pick) ?? shop.find((o) => o.code === pick) ?? null);
  const size = pick === TYPED ? { d: Number(typed.d), l: Number(typed.l) } : chosenTool ? { d: chosenTool.diameter, l: chosenTool.length } : null;
  const sizeOk = !!size && size.d > 0 && size.d <= 200 && size.l > 0 && size.l <= 400;
  const kindName = (type: string) => t(`camAi.tools.${type}`, { defaultValue: type });
  const warns = !size || !sizeOk
    ? []
    : [
        ...(chosenTool && chosenTool.type !== op.type ? [t('camAi.swapPick.kind', { now: kindName(chosenTool.type), was: kindName(op.type) })] : []),
        ...(size.d > op.diameter + 0.001 ? [t('camAi.swapPick.wider')] : []),
        ...(size.l < op.length - 0.01 ? [t('camAi.swapPick.shorter')] : []),
      ];
  const swappedByHand = ops.some((o) => opEdits[o.key]?.tool);
  const others = (inMachine: boolean) => shop.filter((x) => x.inMachine === inMachine && x.code !== op.code && !options.some((o) => o.code === x.code));
  const mill = ops.some((o) => MILL_PURPOSES.has(o.purpose));
  const deepest = Math.min(...ops.map((o) => o.zMin));
  const field = (key: 'rpm' | 'feed' | 'ae' | 'ap', k: 's' | 'f' | 'ae' | 'ap', step: number) => (
    <label className="flex flex-col gap-1 min-w-0 text-xs text-[var(--text-secondary)]">
      {t(`camAi.cut.${key}`)}
      <input
        className="aurora-input w-full min-w-0 h-8 py-0 text-[13px] px-2 tabular-nums"
        type="number"
        min={0}
        step={step}
        inputMode="decimal"
        disabled={busy}
        value={cutText(typedCut[k], draft[k], op[k])}
        placeholder={String(op[k])}
        onChange={(e) => {
          setTypedCut((x) => ({ ...x, [k]: e.target.value }));
          onEdit({ [k]: e.target.value === '' ? undefined : Number(e.target.value) });
        }}
      />
    </label>
  );
  return (
    <div className={`text-[13px] ${op.unsafe ? 'ring-1 ring-[#ef4444]/50 rounded-[8px]' : ''}`}>
      {/* T28 · End mill, then Ø20 · L65 · in the machine. */}
      <div className="pl-4 pr-2 pt-3 pb-3 border-b border-[var(--border-subtle)] flex items-start gap-2">
        <div className="flex-1 min-w-0 pt-1">
        <p className="text-[15px] font-semibold text-[var(--text-primary)]">
          <span className="font-mono">T{op.tool}</span> · {t(`camAi.tools.${op.type}`, { defaultValue: op.type })}
        </p>
        <p className="mt-0.5 text-xs text-[var(--text-secondary)] tabular-nums">
          Ø{fmt(op.diameter, 2)} · L{fmt(op.length, 0)} · {t(op.inMachine ? 'camAi.inMachine' : 'camAi.toLoad')}
          {changed && <span className="text-[var(--blue-text)]"> · {t('camAi.changedBadge')}</span>}
        </p>
        </div>
        {aside}
      </div>
      <div className="p-4 grid grid-cols-2 gap-x-2 gap-y-3">
        {field('rpm', 's', 100)}
        {field('feed', 'f', 10)}
        {mill && field('ae', 'ae', 0.1)}
        {mill && field('ap', 'ap', 0.1)}
        {/* The machine's cooling, the same on every tool (you): shown, never asked. */}
        <p className="col-span-2 text-xs text-[var(--text-secondary)]">
          {t('camAi.cut.coolant')}: <span className="text-[var(--text-primary)]">{t(`camAi.coolant.${op.coolant}`)}</span> · {t('camAi.cut.coolantMachine')}
        </p>
      </div>
      <p className="px-4 pb-2 flex justify-between text-xs text-[var(--text-secondary)] tabular-nums">
        <span>{t('camAi.ops')}</span>
        <span>{fmtTime(ops.reduce((a, o) => a + o.seconds, 0))}{deepest < 0 ? ` · ${t('camAi.deepest', { z: fmt(deepest, 2) })}` : ''}</span>
      </p>
      <ul className="px-2 space-y-0.5" aria-label={t('camAi.ops')}>
        {ops.map((o) => {
          const gone = removing.includes(o.key);
          const on = focus === o.key;
          return (
            <li key={o.key} className={`group flex flex-wrap items-center gap-1 rounded-[8px] ${on ? 'bg-[var(--accent-primary)]/12' : 'hover:bg-[rgba(var(--ov),0.06)]'}`}>
              <button type="button" onClick={() => onFocus(on ? null : o.key)} aria-pressed={on} title={t('camAi.showOnlyThis')} className="no-glass flex-1 min-w-0 text-left px-2 py-1.5 min-h-11">
                <span className={`block text-[13px] ${gone ? 'line-through text-[var(--text-secondary)]' : 'text-[var(--text-primary)]'}`}>{t(`camAi.purpose.${o.purpose}`)}</span>
                <span className="block text-xs text-[var(--text-secondary)] tabular-nums">
                  {fmtTime(o.seconds)}
                  {o.zMin < 0 && ` · ${t('camAi.downTo', { z: fmt(o.zMin, 2) })}`}
                  {!o.learned && ` · ${t('camAi.default')}`}
                </span>
              </button>
              <button
                type="button"
                onClick={() => onRemove(o, !gone)}
                disabled={busy}
                aria-label={t(gone ? 'camAi.keepOp' : 'camAi.removeOp', { name: t(`camAi.purpose.${o.purpose}`) })}
                title={t(gone ? 'camAi.keepOp' : 'camAi.removeOp', { name: t(`camAi.purpose.${o.purpose}`) })}
                className={`no-glass shrink-0 grid place-items-center w-9 h-9 rounded-[6px] text-[var(--text-secondary)] hover:bg-[rgba(var(--ov),0.08)] hover:text-[var(--text-primary)] disabled:opacity-40 ${gone ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`}
              >
                {gone ? <RotateCcw size={15} aria-hidden /> : <Trash2 size={15} aria-hidden />}
              </button>
              {on && onOpEdit && !gone && <OpEditor key={o.key} was={opEdits[o.key]} d={o.diameter} l={o.length} busy={busy || checking} onApply={(e) => onOpEdit(o.key, e)} />}
            </li>
          );
        })}
        {/* Deleted operations (you): crossed out, never gone; Restore brings one back. */}
        {gone.map((g) => (
          <li key={`gone-${g.key}`} className="flex items-center gap-1 rounded-[8px] px-2 py-1.5 min-h-11">
            <span className={`flex-1 min-w-0 text-[13px] text-[var(--text-secondary)] ${g.still ? 'line-through' : ''}`}>
              {t(`camAi.purpose.${g.purpose}`)}
              {!g.still && <span className="block text-xs no-underline">{t('camAi.ws.backNext')}</span>}
            </span>
            {g.still && onRestore && (
              <button type="button" onClick={() => onRestore(g.key)} disabled={busy} aria-label={t('camAi.keepOp', { name: t(`camAi.purpose.${g.purpose}`) })} title={t('camAi.keepOp', { name: t(`camAi.purpose.${g.purpose}`) })} className="no-glass shrink-0 grid place-items-center w-9 h-9 rounded-[6px] text-[var(--text-secondary)] hover:bg-[rgba(var(--ov),0.08)] hover:text-[var(--text-primary)] disabled:opacity-40">
                <RotateCcw size={15} aria-hidden />
              </button>
            )}
          </li>
        ))}
      </ul>
      {op.unsafe && (
        <p className="mx-4 mt-2 flex items-start gap-1.5 text-xs text-[var(--orange-text)]" role="alert">
          <AlertTriangle size={14} className="shrink-0 mt-px" /> {t('camAi.unsafe')}
        </p>
      )}
      <div className="px-4 pt-4 pb-1 space-y-2">
      {swappedByHand && hits > 0 && onUse && (
        <div className="rounded-[8px] border border-[#ef4444]/40 bg-[#ef4444]/10 p-2.5 space-y-2" role="alert">
          <p className="flex items-start gap-1.5 text-xs text-[var(--text-primary)]">
            <AlertTriangle size={14} className="shrink-0 mt-px text-[var(--orange-text)]" aria-hidden /> {t('camAi.swapPick.hits')}
          </p>
          <button type="button" onClick={() => onUse(null)} disabled={busy || checking} className="btn-primary text-xs min-h-9 px-3 w-full justify-center">
            {t('camAi.swapPick.camChoice')}
          </button>
        </div>
      )}
      {!asking ? (
        <button type="button" onClick={() => setAsking(true)} disabled={busy} className="btn-secondary w-full justify-center text-[13px] h-9 px-3 flex items-center gap-2">
          <Repeat size={15} /> {t('camAi.swapTool')}
        </button>
      ) : (
        <div className="space-y-2">
          <label className="block space-y-1">
            <span className="block text-xs text-[var(--text-secondary)]">{t('camAi.standIn')}</span>
            {/* Never wider than the panel: a long tool name is cut in the box, whole in the open list. */}
            <select className="aurora-input w-full min-w-0 h-9 py-0 px-2 text-[13px] truncate cursor-pointer" value={pick} onChange={(e) => setPick(e.target.value)}>
              {/* No pick of CAM AI's: nothing chosen until the operator chooses (the box never shows a tool not picked). */}
              {!pick && <option value="" disabled className="bg-[var(--bg-panel)]">{t('camAi.swapPick.choose')}</option>}
              {options.length > 0 && (
                <optgroup label={t('camAi.swapPick.picks')}>
                  {options.map((o) => (
                    <option key={o.code} value={o.code} className="bg-[var(--bg-panel)]">
                      {toolName(o)}
                      {o.inMachine ? ` · T${o.number}` : ''}
                    </option>
                  ))}
                </optgroup>
              )}
              {([true, false] as const).map((m) =>
                others(m).length ? (
                  <optgroup key={String(m)} label={t(m ? 'camAi.swapPick.machine' : 'camAi.swapPick.db')}>
                    {others(m).map((o) => (
                      <option key={o.code} value={o.code} className="bg-[var(--bg-panel)]">
                        {toolName(o)}
                        {o.inMachine ? ` · T${o.number}` : ''}
                      </option>
                    ))}
                  </optgroup>
                ) : null,
              )}
              {onUse && <option value={TYPED} className="bg-[var(--bg-panel)]">{t('camAi.swapPick.typed')}</option>}
            </select>
          </label>
          {pick === TYPED && (
            <div className="grid grid-cols-2 gap-2">
              {(['d', 'l'] as const).map((k) => (
                <label key={k} className="flex flex-col gap-1 min-w-0 text-xs text-[var(--text-secondary)]">
                  {t(`camAi.swapPick.${k}`)}
                  <input className="aurora-input w-full min-w-0 h-8 py-0 text-[13px] px-2 tabular-nums" type="number" min={0} step={0.1} inputMode="decimal" value={typed[k]} onChange={(e) => setTyped((v) => ({ ...v, [k]: e.target.value }))} />
                </label>
              ))}
            </div>
          )}
          {warns.map((w) => (
            <p key={w} className="flex items-start gap-1.5 text-xs text-[var(--orange-text)]" role="status">
              <AlertTriangle size={14} className="shrink-0 mt-px" aria-hidden /> {w}
            </p>
          ))}
          <div className="flex flex-wrap gap-2">
            {onUse && (
              <button type="button" onClick={() => { if (size && sizeOk) { onUse({ d: size.d, l: size.l, ...(chosenTool ? { code: chosenTool.code } : {}) }); setAsking(false); } }} disabled={busy || checking || !sizeOk} className="btn-primary text-xs min-h-9 px-3 flex-1 justify-center">
                {t('camAi.swapPick.use')}
              </button>
            )}
            {options.some((o) => o.code === pick) && (
              <button type="button" onClick={() => onSwap(op.code, pick)} disabled={busy} className="btn-secondary text-xs min-h-9 px-3 flex-1 justify-center">
                {t('camAi.again')}
              </button>
            )}
            <button type="button" onClick={() => setAsking(false)} className="btn-secondary text-xs min-h-9 px-3">
              {t('camAi.cancel')}
            </button>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}

/**
 * The setup seen from above: the jaws along X (the fixed one at the back, the stop on the left),
 * the part held between them, where the jaws touch it coloured by how hard they press, and the
 * special zones' outlines.
 */
export function ViseView({ setup }: { setup: Setup }) {
  const { t } = useTranslation(['cam', 'remapper', 'common']);
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

/**
 * An operation moved or taken deeper by hand (you, Beta 2: item 10): the whole program is checked again with it; what
 * could hit the machine or the vise still locks it.
 */
function OpEditor({ was, d, l, busy, onApply }: { was?: OpEdit; d: number; l: number; busy: boolean; onApply: (e: OpEdit | null) => void }) {
  const { t } = useTranslation('cam');
  const [v, setV] = useState({ deeper: String(was?.deeper ?? 0), dx: String(was?.dx ?? 0), dy: String(was?.dy ?? 0), dz: String(was?.dz ?? 0), d: String(was?.tool?.d ?? d), l: String(was?.tool?.l ?? l) });
  const nums = { deeper: Number(v.deeper) || 0, dx: Number(v.dx) || 0, dy: Number(v.dy) || 0, dz: Number(v.dz) || 0 };
  const tool = { d: Number(v.d), l: Number(v.l) };
  // The operation's own tool as it is is fine (a face mill is planned with length 0).
  const toolOk = (tool.d === d && tool.l === l) || (tool.d > 0 && tool.d <= 200 && tool.l > 0 && tool.l <= 400);
  // `d`, `l`: the operation's tool now (already the one changed by hand, if so: kept unless undone).
  const newTool = toolOk && (!!was?.tool || tool.d !== d || tool.l !== l);
  const none = Object.values(nums).every((x) => x === 0) && !newTool;
  // Refused here as the planner would refuse it (a refused edit never reaches the program checked).
  const movesOk = editInRange(nums);
  const field = (k: keyof typeof v) => (
    <label key={k} className="space-y-0.5 min-w-0">
      <span className="text-xs text-[var(--text-secondary)]">{t(`camAi.opEdit.${k}`)}</span>
      <input className="aurora-input w-full min-w-0 text-xs px-1.5 tabular-nums" type="number" step={0.5} inputMode="decimal" disabled={busy} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
    </label>
  );
  return (
    <div className="w-full px-2 pb-2 space-y-1.5">
      <div className="grid grid-cols-4 gap-1.5">{(['deeper', 'dx', 'dy', 'dz'] as const).map(field)}</div>
      <div className="grid grid-cols-2 gap-1.5">{(['d', 'l'] as const).map(field)}</div>
      {!movesOk && <p className="text-xs text-[var(--orange-text)]" role="alert">{t('camAi.opEdit.badMove')}</p>}
      {!toolOk && <p className="text-xs text-[var(--orange-text)]" role="alert">{t('camAi.opEdit.badTool')}</p>}
      <div className="flex flex-wrap gap-1.5">
        <button type="button" className="btn-primary text-xs min-h-9 px-3" disabled={busy || !toolOk || !movesOk} onClick={() => onApply(none ? null : { ...nums, ...(newTool ? { tool } : {}) })}>{busy ? t('camAi.opEdit.checking') : t('camAi.opEdit.apply')}</button>
        {was && <button type="button" className="btn-secondary text-xs min-h-9 px-3" disabled={busy} onClick={() => onApply(null)}>{t('camAi.opEdit.undo')}</button>}
      </div>
      <p className="text-xs text-[var(--text-secondary)]">{t('camAi.opEdit.hint')}</p>
    </div>
  );
}

/** Where each tool comes in, in a clamping's operations as they run (their tools' codes): its tool changes, 1 the first. */
export function changesAt(codes: string[]): Map<string, number[]> {
  const at = new Map<string, number[]>();
  let n = 0;
  codes.forEach((c, k) => {
    if (k && codes[k - 1] === c) return;
    n++;
    at.set(c, [...(at.get(c) ?? []), n]);
  });
  return at;
}
