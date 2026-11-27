/*
 * A program opened in CAM AI (you, Beta 2: item 3): an engineer's, not CAM AI's own. The same workspace: its tools
 * by clamping, CAM AI's own simulation, and each run changed by hand (moved, taken deeper: importEdit.ts), simulated
 * and checked again after every change. A tool into the vise or a parallel keeps Download and Send locked.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  IconAlertTriangle as AlertTriangle,
  IconArrowLeft as ArrowLeft,
  IconCircleCheck as CheckCircle2,
  IconCpu as Cpu,
  IconDots as Dots,
  IconDownload as Download,
  IconFileCode as FileCode2,
  IconSend as Send,
  IconX as X,
} from '@tabler/icons-react';
import { Popover } from 'radix-ui';
import { parseToolpath, speedsFor } from '../lib/toolpath';
import { analyseProgram, DEFAULT_JAW_HEIGHT } from '../lib/setups';
import { downloadText } from '../lib/download';
import { editRun, runsOf } from '../lib/cam/importEdit';
import type { OpEdit } from '../lib/cam/opEdit';
import type { MeasureMode } from '../lib/measure';
import type { Measurement } from '../lib/measure3d';
import { fmtNumber as fmt } from '../i18n/format';
import CamSim, { COLORS, hitTools, type SimFocus } from './CamSim';
import type { ModelState } from './Toolpath3D';

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export default function CamOpened({
  name,
  code: first,
  model,
  machine,
  onSend,
  onExit,
  onClose,
}: {
  name: string;
  code: string;
  model: { name: string; bytes: Uint8Array } | null;
  machine: { id: string; name: string; brand?: string } | undefined;
  onSend: (code: string, fileName: string, machine: string) => void;
  onExit: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(['cam', 'remapper']);
  // Every change by hand, the last first undone.
  const [history, setHistory] = useState<string[]>([first]);
  const code = history[history.length - 1];
  const path = useMemo(() => parseToolpath(code, speedsFor(machine?.brand)), [code, machine?.brand]);
  const program = useMemo(() => analyseProgram(path, { jawHeight: DEFAULT_JAW_HEIGHT }), [path]);
  const runs = useMemo(() => runsOf(code), [code]);
  const hits = program.setups.reduce((n, s) => n + s.collisions.filter((c) => c.what !== 'cale' && c.what !== 'spacer').length, 0);
  const cales = program.setups.reduce((n, s) => n + s.collisions.filter((c) => c.what === 'cale').length, 0);
  // Said in tools, as the simulation's badge counts them (the points that hit are far more).
  const tools = hitTools(program.setups);
  const [match, setMatch] = useState<number | null>(null);
  const locked = hits > 0 || cales > 0;
  // Each run's clamping and time, from the moves of its lines.
  const info = useMemo(
    () =>
      runs.map((r) => {
        const moves = path.moves.filter((m) => m.line >= r.from && m.line <= r.to);
        // The tool's description: on its tool change, or where the program reader found it (the next line, a tool list).
        return { setup: moves[0]?.setup ?? 0, seconds: moves.reduce((a, m) => a + m.seconds, 0), d: moves.find((m) => m.dia)?.dia ?? null, label: r.label || moves.find((m) => m.label)?.label || '' };
      }),
    [runs, path],
  );
  const setupCount = Math.max(1, ...info.map((x) => x.setup + 1));
  const [op, setOp] = useState(0);
  const [pick, setPick] = useState<number | null>(null);
  const [focus, setFocus] = useState<SimFocus | null>(null);
  const [edit, setEdit] = useState<OpEdit>({});
  const [measuring, setMeasuring] = useState(false);
  const [measureMode] = useState<MeasureMode>('faces');
  const [, setMeasured] = useState<Measurement>(null);
  const order = useMemo(() => [...new Set(runs.map((r) => r.tool))], [runs]);
  const colour = (tool: number | null) => COLORS[Math.max(0, order.indexOf(tool)) % COLORS.length];
  const run = pick !== null ? runs[pick] : null;
  const changes = history.length - 1;
  const choose = (k: number) => {
    setPick(k);
    setEdit({});
    setOp(info[k].setup);
    setFocus({ setup: info[k].setup, tool: runs[k].tool ?? undefined, key: Date.now() });
  };
  const apply = () => {
    if (!run || pick === null) return;
    const ok = [edit.dx, edit.dy, edit.dz].every((v) => v === undefined || (Number.isFinite(v) && Math.abs(v) <= 200)) && (edit.deeper === undefined || (Number.isFinite(edit.deeper) && Math.abs(edit.deeper) <= 50));
    if (!ok) return;
    setHistory((h) => [...h, editRun(code, run, edit)]);
    setEdit({});
  };
  const barBtn = 'no-glass h-8 shrink-0 whitespace-nowrap inline-flex items-center gap-2 px-3 rounded-[8px] border border-[var(--border-subtle)] text-[13px] text-[var(--text-primary)] hover:bg-[rgba(var(--ov),0.08)] disabled:opacity-40';
  const row = (on: boolean) => `no-glass w-full h-11 flex items-center gap-2.5 px-2 rounded-[8px] text-left ${on ? 'bg-[var(--accent-primary)]/15' : 'hover:bg-[rgba(var(--ov),0.06)]'}`;
  const field = (k: 'dx' | 'dy' | 'dz' | 'deeper') => (
    <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
      {t(`camAi.opEdit.${k}`)}
      <input className="aurora-input h-8 py-0 px-2 text-[13px] tabular-nums" type="number" step={0.1} inputMode="decimal" value={edit[k] ?? ''} onChange={(e) => setEdit({ ...edit, [k]: e.target.value === '' ? undefined : Number(e.target.value) })} />
    </label>
  );

  return (
    <div className="cam-ws h-full w-full flex flex-col bg-[var(--bg-page)] text-[13px] text-[var(--text-primary)]">
      <header className="h-12 shrink-0 flex items-center gap-2 px-2 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)]">
        <button type="button" onClick={onExit} title={t('camAi.ws.backTitle')} aria-label={t('camAi.ws.backTitle')} className="no-glass h-8 flex items-center gap-2 pl-1.5 pr-2.5 rounded-[8px] hover:bg-[rgba(var(--ov),0.08)]">
          <ArrowLeft size={16} stroke={1.8} className="text-[var(--text-secondary)]" aria-hidden />
          <span className="w-6 h-6 rounded-[6px] bg-gradient-to-br from-[var(--blue-500)] to-violet-700 grid place-items-center text-white font-mono font-bold text-xs" aria-hidden>//</span>
          <span className="text-[13px] font-semibold whitespace-nowrap hidden xl:inline">{t('camAi.ws.back')}</span>
        </button>
        <span className="text-[var(--text-tertiary)]" aria-hidden>/</span>
        <span className="flex items-center gap-1.5 shrink-0 whitespace-nowrap">
          <Cpu size={16} stroke={1.6} className="text-[var(--accent-primary)]" aria-hidden />
          <span className="font-semibold">CAM AI</span>
        </span>
        <span className="text-[var(--text-tertiary)]" aria-hidden>/</span>
        <span className="flex items-center gap-1.5 min-w-0">
          <FileCode2 size={16} stroke={1.6} className="shrink-0 text-[var(--text-secondary)]" aria-hidden />
          <span className="font-mono truncate">{name}</span>
        </span>
        <span className={`h-7 shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 px-2.5 rounded-[8px] border text-xs font-medium ${locked ? 'border-[#f87171]/45 bg-[#f87171]/12 text-[#f87171]' : 'border-[#4ade80]/40 bg-[#4ade80]/10 text-[var(--green-text,#1fb257)]'}`} role="status">
          {locked ? <AlertTriangle size={14} aria-hidden /> : <CheckCircle2 size={14} aria-hidden />}
          {locked ? [tools.vise ? t('camAi.open.locked', { count: tools.vise }) : '', tools.cales ? t('camAi.open.lockedCales', { count: tools.cales }) : ''].filter(Boolean).join(' · ') : match !== null ? t('camAi.ws.checked', { pct: fmt(match * 100, 1) }) : t('camAi.open.noHits')}
        </span>
        {changes > 0 && <span className="text-xs text-[var(--blue-text)] whitespace-nowrap">{t('camAi.open.changed', { count: changes })}</span>}
        <span className="flex-1" />
        <button type="button" className={barBtn} disabled={locked} onClick={() => downloadText(name, code, 'application/octet-stream')} title={locked ? t('camAi.open.lockedHelp') : undefined}>
          <Download size={16} stroke={1.6} aria-hidden /> {t('camAi.download')}
        </button>
        <button type="button" className="btn-primary h-8 px-3.5 text-[13px] shrink-0 whitespace-nowrap inline-flex items-center gap-2" disabled={locked || !machine} onClick={() => machine && onSend(code, name, machine.id)} title={locked ? t('camAi.open.lockedHelp') : undefined}>
          <Send size={16} stroke={1.8} aria-hidden /> {t('camAi.send')}
        </button>
        <Popover.Root>
          <Popover.Trigger asChild>
            <button type="button" className="no-glass w-8 h-8 grid place-items-center rounded-[8px] border border-[var(--border-subtle)] hover:bg-[rgba(var(--ov),0.08)]" aria-label={t('camAi.ws.more')} title={t('camAi.ws.more')}>
              <Dots size={18} stroke={1.8} aria-hidden />
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content align="end" sideOffset={6} className="cam-pop z-[1000] w-64 p-1">
              <Popover.Close asChild>
                <button type="button" className="no-glass w-full flex items-center gap-2.5 h-9 px-2.5 rounded-[6px] text-[13px] text-left hover:bg-[rgba(var(--ov),0.08)]" onClick={onClose}>
                  <X size={16} stroke={1.6} aria-hidden /> {t('camAi.open.close')}
                </button>
              </Popover.Close>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </header>

      <div className="flex-1 min-h-0 flex">
        <nav aria-label={t('camAi.ws.tools')} className="w-[260px] shrink-0 flex flex-col overflow-y-auto border-r border-[var(--border-subtle)] bg-[var(--bg-panel)]">
          <div role="tablist" aria-label={t('camAi.ws.clampings')} className="m-2 grid gap-0.5 p-0.5 rounded-[8px] border border-[var(--border-subtle)]" style={{ gridTemplateColumns: `repeat(${setupCount}, minmax(0, 1fr))` }}>
            {Array.from({ length: setupCount }, (_, i) => (
              <button key={i} type="button" role="tab" aria-selected={op === i} onClick={() => { setOp(i); setFocus({ setup: i, key: Date.now() }); }} className={`no-glass h-8 rounded-[6px] text-[13px] ${op === i ? 'bg-[rgba(var(--ov),0.12)] font-semibold' : 'text-[var(--text-secondary)]'}`}>
                OP{(i + 1) * 10}
              </button>
            ))}
          </div>
          <ul className="px-2 space-y-0.5">
            {runs.map((r, k) =>
              info[k].setup !== op ? null : (
                <li key={k}>
                  <button type="button" className={row(pick === k)} onClick={() => choose(k)} aria-current={pick === k || undefined}>
                    <span title={`T${r.tool}`} className="w-[52px] h-[22px] shrink-0 grid place-items-center rounded-[6px] font-mono text-xs overflow-hidden whitespace-nowrap" style={{ background: `${colour(r.tool)}26`, color: colour(r.tool) }}>
                      {`T${r.tool}`.length > 5 ? `T${r.tool}`.slice(0, 4) + '…' : `T${r.tool}`}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block truncate font-medium">{info[k].label || t('camAi.open.noLabel')}</span>
                      {info[k].d && <span className="block text-xs text-[var(--text-secondary)] tabular-nums">Ø{fmt(info[k].d!, 2)}</span>}
                    </span>
                    <span className="text-xs text-[var(--text-secondary)] tabular-nums">{clock(info[k].seconds)}</span>
                  </button>
                </li>
              ),
            )}
          </ul>
        </nav>

        <main className="flex-1 min-w-0 relative">
          <CamSim
            code={code}
            brand={machine?.brand}
            model={model}
            focus={focus}
            selected={run ? { setup: info[pick!].setup, tool: run.tool ?? -1 } : null}
            runLabel={(_, tool) => { const k = runs.findIndex((r) => r.tool === tool); return k >= 0 ? `T${tool} · ${info[k].label}` : tool === null ? '' : `T${tool}`; }}
            stepLabel={(i) => `OP${(i + 1) * 10}`}
            parallels={(i) => {
              const s = program.setups[i];
              return !s ? '' : s.onJaw !== null ? t('camAi.sim.onJaw') : s.support === 0 ? t('camAi.sim.onTable') : s.support !== null ? t('camAi.sim.parallels', { mm: fmt(s.support, 0) }) : '';
            }}
            nx={false}
            measure={{ on: measuring, mode: measureMode, onMeasure: setMeasured }}
            onMeasureToggle={() => setMeasuring((x) => !x)}
            onModel={(s: ModelState) => setMatch(s.state === 'ready' ? s.match : null)}
          />
        </main>

        <aside aria-label={t('camAi.ws.inspector')} className="w-[300px] shrink-0 flex flex-col overflow-y-auto border-l border-[var(--border-subtle)] bg-[var(--bg-panel)]">
          {run && pick !== null ? (
            <>
              <div className="px-4 pt-4 pb-3 border-b border-[var(--border-subtle)]">
                <p className="text-[15px] font-semibold"><span className="font-mono">T{run.tool}</span> · {info[pick].label || t('camAi.open.noLabel')}</p>
                <p className="mt-0.5 text-xs text-[var(--text-secondary)] tabular-nums">
                  {t('camAi.open.lines', { from: run.from + 1, to: run.to + 1 })} · {clock(info[pick].seconds)}
                </p>
              </div>
              <div className="p-4 grid grid-cols-2 gap-x-2 gap-y-3">
                {field('dx')}
                {field('dy')}
                {field('dz')}
                {field('deeper')}
              </div>
              <div className="px-4 flex gap-2">
                <button type="button" className="btn-primary h-9 px-3 text-[13px] flex-1" onClick={apply} disabled={!Object.values(edit).some((v) => v)}>{t('camAi.opEdit.apply')}</button>
                <button type="button" className="btn-secondary h-9 px-3 text-[13px]" onClick={() => setHistory((h) => h.slice(0, -1))} disabled={!changes}>{t('camAi.opEdit.undo')}</button>
              </div>
              <p className="px-4 pt-3 text-xs text-[var(--text-secondary)]">{t('camAi.open.hint')}</p>
            </>
          ) : (
            <p className="p-4 text-[var(--text-secondary)]">{t('camAi.open.pick')}</p>
          )}
          {locked && <p className="mx-4 mt-3 flex gap-2 text-xs text-[var(--orange-text)]" role="alert"><AlertTriangle size={14} className="shrink-0" aria-hidden />{t('camAi.open.lockedHelp')}</p>}
          {!model && <p className="px-4 pt-3 text-xs text-[var(--text-secondary)]">{t('camAi.open.noModel')}</p>}
        </aside>
      </div>
    </div>
  );
}
