import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { IconArrowDown as ArrowDown, IconArrowUp as ArrowUp, IconArrowsMaximize as JawsOpen, IconArrowsMinimize as JawsClose, IconChevronDown as ChevronDown, IconChevronUp as ChevronUp, IconAlertTriangle as AlertTriangle, IconBox as Box, IconCheck as Check, IconCircleCheck as CheckCircle2, IconCircle as Circle, IconCpu as Cpu, IconDownload as Download, IconRuler as Ruler, IconFileCode as FileCode2, IconFilePlus as FilePlus2, IconLoader2 as Loader2, IconLock as Lock, IconClick as MousePointerClick, IconPencil as Pencil, IconPlayerPlay as Play, IconRefresh as RefreshCw, IconRoute as Route, IconSend as Send, IconSettings as Settings2, IconSquare as Square, IconUpload as Upload, IconArrowLeft as ArrowLeft, IconCube as Cube, IconX as X, IconDots as Dots, IconClockHour4 as Clock, IconLayoutSidebarLeftCollapse as SidebarLeftCollapse, IconLayoutSidebarLeftExpand as SidebarLeftExpand, IconLayoutSidebarRightCollapse as SidebarRightCollapse, IconLayoutSidebarRightExpand as SidebarRightExpand, IconStack2 as Parallels, IconPlayerPlay as PlayerPlay, IconDatabase as Database, IconTrash as Trash, IconRotate as RotateCcw } from '@tabler/icons-react';
import { Dialog, Popover } from 'radix-ui';
import { useSync } from '../contexts/SyncContext';
import { useTranslation } from 'react-i18next';
import '../i18n/camLocales';
import { fmtNumber as fmt, locale } from '../i18n/format';
import { api } from '../lib/api';
import { downloadBlob } from '../lib/download';
import { currentRegion } from '../lib/instance';
import { MODEL_MAX_BYTES, type ModelError } from '../lib/modelLimits';
import { speedsFor } from '../lib/toolpath';
import { DEFAULT_LIMITS } from '../lib/cam/limits';
import { coolingOf, engineMachineId, isLockedMachine, materialNeed } from '../regions';
import { forMachine } from '../lib/cam/export';
import { alternatives, CAM_MATERIALS, catalog, FAMILY, type CamMaterial } from '../lib/cam/tools';
import { PART_TYPES, type PartType } from '../lib/cam/partType';
import { renderViews } from '../lib/cam/thumbs';
import type { CamMessage, CamRequest, CamSummary, Prepared } from '../lib/cam/cam.worker';
import type { Purpose } from '../lib/cam/program';
import { liveStep, NO_LIVE, type Live } from '../lib/cam/live';
import type { MeasureMode } from '../lib/measure';
import type { Measurement } from '../lib/measure3d';
import { IDENTITY, type Mat3 } from '../lib/orient';
import { alike, badToolNumber, fmtTime, passed, ProgramPanel, safe, safeButHold, SetupPanel, ToolCard, useToolName, useVerdict } from './CamAiResult';
import type { ClampAct, FacePick } from './CamPartView';
import CamStockBox, { STOCK_SIDES } from './CamStockBox';
import CamSim, { COLORS as SIM_COLORS, type SimFocus } from './CamSim';
import CamOpened from './CamOpened';
import CamToolDb, { loadToolDb, type Stored as StoredToolDb } from './CamToolDb';
import { FRENCH as SHAPE_FR, type Shape } from '../lib/cam/shapes';
import { allowedCales, blankSides, clearOf, firstPick, GRIP_WANT, JAW, jawMove, refusedHold, stepCale, TOP_MIN, underStock, whyNot } from '../lib/cam/clamp';
import type { CutEdit } from '../lib/cam/tools';
import type { OpEdit } from '../lib/cam/opEdit';
import { useAuth } from '../contexts/AuthContext';

const CamPartView = lazy(() => import('./CamPartView'));
const CamTurnGhost = lazy(() => import('./CamTurnGhost'));
/**
 * A clamping's operations in the order the operator asked (their keys): those listed run in that order in the places
 * they hold, the others stay where they were made (as program.ts reorderOps does).
 */
const inOrder = <T extends { key: string }>(side: string, ops: T[], asked: Record<string, string[]>) => {
  const want = asked[side] ?? [];
  const rank = (o: T) => want.indexOf(o.key);
  const listed = ops.filter((o) => rank(o) >= 0).sort((a, b) => rank(a) - rank(b));
  let j = 0;
  return ops.map((o) => (rank(o) >= 0 ? listed[j++] : o));
};
/** Its tools (by code), one row each, where each first runs. */
const toolOrder = (side: string, ops: { key: string; code: string }[], asked: Record<string, string[]>) => [...new Set(inOrder(side, ops, asked).map((o) => o.code))];
/** The tool an operation was made with (its key: side|name|code|n), whatever it was changed to by hand. */
const madeCode = (key: string) => key.split('|')[2];
/** A quarter turn about the machine's X or Y, + or - (you: the presses add up). */
const QUARTER: Record<string, Mat3> = { 'X+': [1, 0, 0, 0, 0, -1, 0, 1, 0], 'X-': [1, 0, 0, 0, 0, 1, 0, -1, 0], 'Y+': [0, 0, 1, 0, 1, 0, -1, 0, 0], 'Y-': [0, 0, -1, 0, 1, 0, 1, 0, 0] };
const mul3 = (a: Mat3, b: Mat3): Mat3 => [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j])) as Mat3;
/** The model side a turn puts up. */
const upOf = (R: Mat3) => (['Z+', 'Z-', 'X+', 'X-', 'Y+', 'Y-'] as const).find((n) => { const k = 'XYZ'.indexOf(n[0]); const sg = n[1] === '+' ? 1 : -1; return R[6 + k] * sg === 1; })!;
/** The presses, the ones in a row about one axis added up: "X +180°, Y -90°". */
const pressText = (ps: string[]) => {
  const out: { axis: string; deg: number }[] = [];
  for (const p of ps) {
    const deg = p[1] === '+' ? 90 : -90;
    const last = out[out.length - 1];
    if (last && last.axis === p[0]) last.deg += deg;
    else out.push({ axis: p[0], deg });
  }
  // 0, 90, 180 or 270 (-90) each.
  const said = (deg: number) => ({ 90: '+90°', 180: '180°', 270: '−90°' })[(((deg % 360) + 360) % 360) as 90 | 180 | 270];
  return out.filter((x) => x.deg % 360 !== 0).map((x) => `${x.axis} ${said(x.deg)}`).join(', ');
};

/** The automatic raw block: the part plus 4 mm in X and Y and 7 mm in Z (in the vise), centred. */
const AUTO_EXCESS = [4, 4, 7];
/** The side facing the other way ('Z+' -> 'Z-'). */
const opposite = (side: string) => side[0] + (side[1] === '+' ? '-' : '+');

type Model = { name: string; bytes: Uint8Array };
type Run = { state: 'idle' } | { state: 'preparing' } | { state: 'busy'; done: number; of: number } | { state: 'error'; error: ModelError | 'failed' | 'toolDb' | 'thinBlank' } | { state: 'done'; result: CamSummary };
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
/** Stock on each side of clamping 1 (lo: X-, Y-, Z-; hi: X+, Y+, Z+) as the model's sides (as layouts.ts: toModelSides). */
const toModelSides = (R: Mat3, lo: number[], hi: number[]) => {
  const j = [0, 1, 2].map((k) => [0, 1, 2].find((i) => R[i * 3 + k] !== 0)!);
  const up = j.map((i, k) => R[i * 3 + k] > 0);
  return { lo: j.map((i, k) => (up[k] ? lo : hi)[i]) as Vec3, hi: j.map((i, k) => (up[k] ? hi : lo)[i]) as Vec3 };
};
type Vec3 = [number, number, number];
/** A side of the model ('X-', 'Z+', ...) as a side of clamping 1, 0..5 in the order X-, X+, Y-, Y+, Z-, Z+. */
const viseSide = (R: Mat3, side: string) => {
  const k = 'XYZ'.indexOf(side[0]);
  const j = [0, 1, 2].find((i) => R[i * 3 + k] !== 0)!;
  return 2 * j + (R[j * 3 + k] * (side[1] === '-' ? -1 : 1) > 0 ? 1 : 0);
};

/**
 * CAM AI, step by step: the part's 3D model; its name and type (from the PDF, the operator
 * confirms or changes it); how it lies in the vise (best first, each shown); the raw part (as the
 * part, or the excess left on it); the machine and material (inox asks to use the MS templates, any
 * other material asks for the family to program it with). Then the program, simulated and checked
 * (lib/cam/program.ts); Download and Send only once every check passes (CamAiResult).
 */
export default function CamAi({ onSend, onExit }: { onSend: (code: string, fileName: string, machine: string) => void; onExit: () => void }) {
  const { user } = useAuth();
  const { t } = useTranslation(['cam', 'remapper', 'common']);
  const { toolbox, toolMachines: allMachines } = useSync();
  // DMG machines are not programmed in the app for now (shop decision).
  const toolMachines = useMemo(() => allMachines.filter((m) => !isLockedMachine(m)), [allMachines]);
  const [model, setModel] = useState<Model | null>(null);
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [views, setViews] = useState<string[]>([]);
  const [partType, setPartType] = useState<PartType | ''>('');
  const [layout, setLayout] = useState(0);
  // Setups, one after the other: setup 1's top face (the layout's side, or a face picked on the
  // model), confirmed; then setup 2's (CAM AI proposes the opposite side), confirmed.
  const [face1, setFace1] = useState<string | undefined>();
  // The walls the operator picks to finish (each its model triangles): only those get a finishing pass.
  const [finishWalls, setFinishWalls] = useState<number[][]>([]);
  const finishTris = useMemo(() => finishWalls.flat(), [finishWalls]);
  const [pickWalls, setPickWalls] = useState(false);
  // A top plate's white face (a side name), never faced: picked on the model.
  const [white, setWhite] = useState<string | undefined>();
  const [pickWhite, setPickWhite] = useState(false);
  const [locked1, setLocked1] = useState(false);
  const [second, setSecond] = useState<{ side: string; face?: string } | null>(null);
  const [locked2, setLocked2] = useState(false);
  const [pickNote, setPickNote] = useState<'' | 'noFit' | 'same'>('');
  // The raw block: automatic (+4, +4, +7), or typed as totals (centred) or side by side (X-, X+, Y-, Y+, Z-, Z+ of clamping 1).
  const [autoStock, setAutoStock] = useState(true);
  const [stockMode, setStockMode] = useState<'total' | 'side'>('total');
  const [totals, setTotals] = useState(['', '', '']);
  const [sides, setSides] = useState(['2', '2', '2', '2', '5', '2']);
  // The designer's parallels for clamping 1 (you, Beta 2): a height, 0 for none, null for CAM AI's own; the jaw's
  // opening and the part's slide toward the operator are the view's only (mm); refused moves flash the jaws.
  const [clamp1, setClamp1] = useState<number | null>(null);
  // Operations changed by hand on the program made (by key), one being checked, the part accepted as it then is.
  const [opEdits, setOpEdits] = useState<Record<string, OpEdit>>({});
  const [checking, setChecking] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [editsDropped, setEditsDropped] = useState(false);
  // A change by hand the worker refused: the program shown stays, without it (never thrown away, nor carried on).
  const [editRefused, setEditRefused] = useState(false);
  // The edits the program shown was checked with, and those sent to be checked since (oldest first, each with the last
  // change listed when it was sent): what a refused one goes back to.
  const checkedEdits = useRef<{ edits: Record<string, OpEdit>; order: Record<string, string[]> }>({ edits: {}, order: {} });
  const sentEdits = useRef<{ edits: Record<string, OpEdit>; order: Record<string, string[]>; id: number }[]>([]);
  // The operation an edit was applied to, to keep it picked when the edited program comes back.
  const following = useRef<string | null>(null);
  // The spacer between the stop and the part in clamping 1 (the shop's 15 or 50 mm), 0 for none.
  const [stop1, setStop1] = useState<0 | 15 | 50>(0);
  // Later clampings' parallels, by clamping (1: the second), chosen on the program made: used when it is made again.
  const [later, setLater] = useState<Record<number, Hold>>({});
  // Spacers asked by clamping (item 3): at the stop (X-, later clampings; clamping 1 has stop1) and in the moving jaw
  // (Y-: 15, or 0 for none; absent: CAM AI decides).
  const [laterX, setLaterX] = useState<Record<number, LaterX>>({});
  // A change upstream: what the later clampings hold changes, so their choices go (clamping 1's own spacer stays).
  const resetLater = () => {
    setLater({});
    setLaterX((x): Record<number, LaterX> => (x[0] ? { 0: x[0] } : {}));
    setTurned((x): Record<number, { R: Mat3; presses: string[] }> => (x[0] ? { 0: x[0] } : {}));
  };
  // Each clamping as the operator turned it (you: +90 / -90 about X or Y in its settings), and the presses that made it.
  const [turned, setTurned] = useState<Record<number, { R: Mat3; presses: string[] }>>({});
  const [jaw, setJaw] = useState({ open: 0, slide: 0 });
  const [flash, setFlash] = useState(0);
  const [nextHint, setNextHint] = useState<number | undefined>();
  const hintTimer = useRef(0);
  const [live, setLive] = useState<Live>(NO_LIVE);
  const [cuts, setCuts] = useState<Record<string, CutEdit>>({});
  // Operations the operator removed: in the program already (skip), and marked since (skipDraft, for the next time it is made).
  const [skip, setSkip] = useState<string[]>([]);
  const [skipDraft, setSkipDraft] = useState<string[]>([]);
  const [skipLabels, setSkipLabels] = useState<Record<string, string>>({});
  // What each deleted operation was (you: a deleted one stays in the lists, crossed out, until restored), by key.
  type GoneOp = { side: string; code: string; tool: number; type: string; diameter: number; length: number; purpose: Purpose };
  const [gone, setGone] = useState<Record<string, GoneOp>>({});
  // The clamping whose settings are open (its OP's settings button, or Adjust): after a program is made, clamping 1's
  // parallels editor opens only so (you: never just by going to OP10).
  const [setupOpen, setSetupOpen] = useState<number | null>(null);
  // Tools changed by hand, by clamping side and the tool they replace (you: a tool change always applies, also after Make
  // again: where the plan made again still uses the old tool there, the new one takes its paths).
  const [toolSwaps, setToolSwaps] = useState<Record<string, { d: number; l: number; code?: string }>>({});
  // The operator's order of each clamping's tools (you: dragged in the list), by side: sent with every change by hand,
  // kept after Make again for the tools still there (program.ts reorderOps).
  const [opOrder, setOpOrder] = useState<Record<string, string[]>>({});
  const orderRef = useRef(opOrder);
  orderRef.current = opOrder;
  const editsRef = useRef<Record<string, OpEdit>>({});
  editsRef.current = opEdits;
  // The tool row being dragged, and the row it would land before.
  const [dragCode, setDragCode] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  // The changes since the program was made, newest last: listed by the one Make again button and undone one at a time,
  // newest first (the owner). A change can carry what the next make takes from it: a shop tool preferred, operations
  // left out; a typed cutting value or an operation removed is shown only while it is still pending.
  // now: in the program shown already (checked again); the others wait for Make again.
  // sideStock: the side stock the program shown was made with (one change for it, however many keys are typed).
  type Change = { id: number; label: string; undo?: () => void; swap?: { exclude: string; prefer: string }; skip?: Record<string, string>; cuts?: string; removed?: string; now?: true; sideStock?: number };
  const [changes, setChanges] = useState<Change[]>([]);
  const changeId = useRef(0);
  // The later clampings' turns the program shown was made with (the panel's "until it is made again").
  const [madeTurns, setMadeTurns] = useState<Record<number, Pick<LaterX, 'flip' | 'quarter'>>>({});
  const turnsAsked = useRef<Record<number, Pick<LaterX, 'flip' | 'quarter'>>>({});
  const addChange = (c: Omit<Change, 'id'>) => setChanges((l) => [...l, { ...c, id: ++changeId.current }]);
  // Hand edits carried over to the next program made (where their operation is still in it).
  const carry = useRef<Record<string, OpEdit> | null>(null);
  // The last program as made (never one changed by hand): what carried edits are checked against.
  const plain = useRef<CamSummary | null>(null);
  // A clamping changed on a made program: listed, its Undo back to every hold choice as it was before this change.
  const holdChanged = (label: string) => {
    if (!result) return;
    // The later clampings' turns too (the change cleared them: resetLater).
    const was = { clamp1, stop1, later, laterX, turned };
    addChange({
      label,
      undo: () => {
        setClamp1(was.clamp1);
        setStop1(was.stop1);
        setLater(was.later);
        setLaterX(was.laterX);
        setTurned(was.turned);
      },
    });
  };
  // What a clamping's change was, in words.
  const holdLabel = (n: number, wasHold: Hold | undefined, wasX: LaterX, hold: Hold | null, x: LaterX): string => {
    if (hold === null && !Object.keys(x).length) return t('camAi.changes.own', { n });
    if (hold && JSON.stringify(hold) !== JSON.stringify(wasHold ?? null))
      return 'jaw' in hold ? t('camAi.changes.jaw', { n, mm: fmt(hold.jaw, 1) }) : 'step' in hold ? t('camAi.changes.step', { n, mm: fmt(hold.step, 1) }) : hold.cale === 0 ? t('camAi.changes.table', { n }) : t('camAi.changes.parallels', { n, mm: fmt(hold.cale, 0) });
    if (x.side !== wasX.side) return x.side ? t('camAi.changes.side', { n, side: x.side }) : t('camAi.changes.own', { n });
    if (x.stop !== wasX.stop) return x.stop ? t('camAi.changes.stop', { n, mm: x.stop }) : t('camAi.changes.stopNone', { n });
    if (x.y !== wasX.y) return x.y === undefined ? t('camAi.changes.yAuto', { n }) : x.y ? t('camAi.changes.y', { n, mm: x.y }) : t('camAi.changes.yNone', { n });
    if (x.flip !== wasX.flip) return x.flip ? t('camAi.changes.flip', { n, axis: x.flip }) : t('camAi.changes.flipAuto', { n });
    if (x.quarter !== wasX.quarter) return t('camAi.changes.quarter', { n, deg: (x.quarter ?? 0) * 90 });
    return t('camAi.hold.changed', { n });
  };
  // A tool's row asked to be deleted (its clamping, its code): confirmed in a dialog, then made again without it.
  const [dropAsk, setDropAsk] = useState<{ i: number; code: string; tool: number } | null>(null);
  // The removed operations' paths, from the program before (shown faded), and the one picked in the list.
  const [ghosts, setGhosts] = useState<Live['paths']>([]);
  const [ghostOn, setGhostOn] = useState<string | null>(null);
  const pendingSkips = [...new Set([...skip, ...skipDraft])].filter((k) => skip.includes(k) !== skipDraft.includes(k)).length;
  const [machineId, setMachineId] = useState(() => toolMachines[0]?.id ?? '');
  // None until chosen (a default material warned against the default machine before anything was chosen).
  const [material, setMaterial] = useState<CamMaterial | 'INOX' | 'OTHER' | ''>('');
  const [family, setFamily] = useState<Family>('ALU');
  const [sideStock, setSideStock] = useState(readSideStock);
  // The side stock as typed (null: as kept): only 0 to 0.5 mm is kept, anything else is said, never changed under the caret.
  const [sideText, setSideText] = useState<string | null>(null);
  const sideTextOk = sideText === null || (sideText.trim() !== '' && Number(sideText) >= 0 && Number(sideText) <= 0.5);
  const [swap, setSwap] = useState<{ exclude: string[]; prefer: string[] }>({ exclude: [], prefer: [] });
  const [run, setRun] = useState<Run>({ state: 'idle' });
  // The simulation open, and how it opens: playing, on the weak spots or in the NX view.
  const worker = useRef<Worker | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const machine = toolMachines.find((m) => m.id === machineId) ?? toolMachines[0];
  const tools = machine ? toolbox[machine.id] ?? [] : [];
  const name = model ? model.name.replace(/\.(pdf|stl)$/i, '') : '';
  const fileName = `${name || 'PROGRAMM'}.nc`;
  // The material the templates are taken for (inox waits for the operator's yes to MS).
  const templatesFor: CamMaterial | null = material === 'INOX' || material === '' ? null : material === 'OTHER' ? family : material;
  // Shop rule, for the material the program is made and labelled for (Process reads that label).
  const need = materialNeed(templatesFor);
  const cooling = machine ? coolingOf(engineMachineId(currentRegion().id, machine)) : null;
  const wrongCooling = !!need && !!cooling && need !== cooling;
  const busy = run.state === 'busy' || run.state === 'preparing';
  const picked = prep?.layouts[layout];
  // Clamping 1 turned by hand (its settings): its blank, its sides and its parallels as it lies so, never as picked.
  const chosen =
    picked && prep && turned[0]
      ? { ...picked, R: turned[0].R, side: upOf(turned[0].R), spin: false, size: [0, 1, 2].map((j) => [0, 1, 2].reduce((a, k) => a + Math.abs(turned[0].R[j * 3 + k]) * prep.size[k], 0)) as typeof picked.size }
      : picked;
  // A top plate's white face as a side of clamping 1 (0..5 as X-, X+, Y-, Y+, Z-, Z+): no stock on it, ever.
  const whiteAt = chosen && partType === 'topPlate' && white ? viseSide(chosen.R, white) : -1;
  const sideValue = (i: number) => (i === whiteAt ? 0 : Number(sides[i]));
  // What is added to the part in the vise's X, Y, Z (centred: half on each side).
  const excess: number[] | null = !chosen
    ? null
    : autoStock
      ? AUTO_EXCESS
      : stockMode === 'total'
        ? totals.map((v, k) => Number(v) - chosen.size[k])
        : [0, 1, 2].map((k) => sideValue(k * 2) + sideValue(k * 2 + 1));
  // Side by side: each side on its own (a side under 0 would put the blank's face inside the part).
  const sidesOk = autoStock || stockMode !== 'side' || [0, 1, 2, 3, 4, 5].every((i) => Number.isFinite(sideValue(i)) && sideValue(i) >= 0 && sideValue(i) <= 200);
  const excessOk = !!excess && sidesOk && excess.every((v) => Number.isFinite(v) && v >= 0 && v <= 200);
  const raw = prep && chosen && excess && excessOk ? (toModelAxes(chosen.R, excess).map((e, k) => prep.size[k] + e) as [number, number, number]) : null;
  // The blank side by side in clamping 1 (X-, X+, Y-, Y+, Z-, Z+): as typed, or where the planner puts Auto and totals
  // (clamp.ts); as the model's sides, and the blank it makes (model frame, centred on the part) that the 3D view draws.
  const shown = chosen && excess && raw ? (!autoStock && stockMode === 'side' ? [0, 1, 2, 3, 4, 5].map(sideValue) : blankSides(excess, whiteAt)) : null;
  const shownSides = chosen && shown ? toModelSides(chosen.R, [0, 2, 4].map((i) => shown[i]), [1, 3, 5].map((i) => shown[i])) : null;
  const sideBlank = prep && shownSides ? { lo: prep.size.map((s, k) => -s / 2 - shownSides.lo[k]), hi: prep.size.map((s, k) => s / 2 + shownSides.hi[k]) } : null;
  // Clamping 1's parallels (clamp.ts, as the planner takes them): those the jaws hold the blank on, lowest first, and CAM AI's own.
  const lo1 = chosen && shown ? -(chosen.size[2] + shown[4]) : 0;
  const stockH1 = chosen && shown ? chosen.size[2] + shown[4] + shown[5] : 0;
  const cales1 = chosen && shown ? allowedCales(stockH1, lo1, chosen.size[2]).sort((p, q) => p - q) : [];
  // The 0.5 mm method (you): 5 mm under the part wanted (a 4 mm grip), 4 taken (3 mm, yellow), less refused.
  const under1 = chosen && shown ? underStock(shown[4]) : null;
  // And 0.5 mm over the part to face (you), but on a top plate's white face.
  const topThin = !!chosen && !!shown && whiteAt !== 5 && shown[5] < TOP_MIN - 1e-6;
  const own1 = chosen && shown && cales1.length ? firstPick(stockH1, lo1, chosen.size[2]).cale : null;
  // The program made says what CAM AI used (its blank may have gone centred); before one, the page's own pick.
  const cale1 = clamp1 ?? (run.state === 'done' ? run.result.setups[0]?.cale : undefined) ?? own1;
  // Sent to the planner when typed side by side, or with the designer's parallels (the blank they were chosen for, never
  // the centred fallback); else it places Auto and totals itself, centred when that fails.
  const margins = shownSides && ((!autoStock && stockMode === 'side') || clamp1 !== null) ? shownSides : undefined;
  const side2 = second?.side ?? (chosen ? opposite(chosen.side) : '');
  const picking = !prep || busy ? null : !locked1 ? 0 : !locked2 ? 1 : null;
  const picks: FacePick[] = chosen ? [{ side: chosen.side, face: face1, locked: locked1 }, ...(locked1 ? [{ side: side2, face: second?.face, locked: locked2 }] : [])] : [];
  // Parallels that cannot hold the part are shown (yellow) but never made: why, if so.
  const refused1 = chosen && clamp1 !== null ? whyNot(clamp1, stockH1, lo1, chosen.size[2]) : null;
  const ready = !!prep && !!partType && !!chosen?.fits && locked1 && locked2 && !!raw && !!machine && tools.length > 0 && !!templatesFor && !wrongCooling && !refused1 && under1 !== 'tooThin' && !topThin;

  // Made again over a program shown: the page as it was, and the worker holding that program's plan, back on Stop (you:
  // Stop cancels only the new make); gone once the new one is made or fails.
  const remake = useRef<{ run: Run; changes: Change[]; swap: typeof swap; cuts: typeof cuts; skip: string[]; skipDraft: string[]; skipLabels: Record<string, string>; live: Live; ghosts: Live['paths']; worker: Worker | null } | null>(null);
  const endRemake = () => {
    remake.current?.worker?.terminate();
    remake.current = null;
  };
  // Each make, counted: one stopped while the tool database loads never goes on to make.
  const makeSeq = useRef(0);
  useEffect(
    () => () => {
      worker.current?.terminate();
      remake.current?.worker?.terminate();
    },
    [],
  );

  const newWorker = () => {
    worker.current?.terminate();
    const w = new Worker(new URL('../lib/cam/cam.worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    w.onerror = () => {
      if (worker.current === w) endRemake();
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
    endRemake();
    setModel(m);
    setChanges([]);
    // Nothing by hand from the part before goes on with this one (a review: they reached its program).
    setOpEdits({});
    setGone({});
    setToolSwaps({});
    setOpOrder({});
    setTurned({});
    orderRef.current = {};
    editsRef.current = {};
    setEditsDropped(false);
    setEditRefused(false);
    carry.current = null;
    plain.current = null;
    setPrep(null);
    setViews([]);
    setFace1(undefined);
    setFinishWalls([]);
    setPickWalls(false);
    setWhite(undefined);
    setPickWhite(false);
    setLocked1(false);
    setSecond(null);
    setLocked2(false);
    setPickNote('');
    setTotals(['', '', '']);
    setClamp1(null);
    setStop1(0);
    setLater({});
    setLaterX({});
    setJaw({ open: 0, slide: 0 });
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
    makeSeq.current++;
    worker.current?.terminate();
    worker.current = null;
    const was = remake.current;
    remake.current = null;
    if (!was) return setRun({ state: 'idle' });
    // The program shown before, its changes as listed and its plan's worker (for changes by hand).
    worker.current = was.worker;
    setRun(was.run);
    setChanges(was.changes);
    setSwap(was.swap);
    setCuts(was.cuts);
    setSkip(was.skip);
    setSkipDraft(was.skipDraft);
    setSkipLabels(was.skipLabels);
    setLive(was.live);
    setGhosts(was.ghosts);
  };

  const generate = async (with_ = swap, edits = cuts, skips = skip) => {
    // The hand edits Make again carries (this make only), and the program they were made on.
    const carrying = carry.current;
    const swapsAll = toolSwaps;
    carry.current = null;
    const before = plain.current;
    if (!model || !machine || !ready || !chosen || !templatesFor || !partType) return;
    // The page as this render has it, before Make again changed it (its setters take effect on the next render).
    endRemake();
    if (run.state === 'done') {
      remake.current = { run, changes, swap, cuts, skip, skipDraft, skipLabels, live, ghosts, worker: worker.current };
      worker.current = null;
    }
    setRun({ state: 'busy', done: 0, of: 1 });
    const seq = ++makeSeq.current;
    // The shop's tool database as it is now (it may have changed since): never a program made without it.
    let db: StoredToolDb;
    try {
      db = await loadToolDb();
    } catch {
      if (seq !== makeSeq.current) return;
      endRemake();
      return setRun({ state: 'error', error: 'toolDb' });
    }
    if (seq !== makeSeq.current) return;
    setToolDb(db);
    // A tool changed by hand that the shop no longer has here (another machine, the database changed): not carried, said.
    const shelf = catalog(templatesFor, tools, { toolDb: db.db });
    const swapsNow = Object.fromEntries(Object.entries(swapsAll).filter(([, x]) => !x.code || shelf.some((c) => c.code === x.code)));
    const swapsLost = Object.keys(swapsNow).length < Object.keys(swapsAll).length;
    const w = newWorker();
    // Edits sent to the worker just replaced are never answered: none counts as refused.
    sentEdits.current = [];
    setChecking(false);
    const speeds = speedsFor(machine.brand);
    const request: CamRequest = {
      model,
      material: templatesFor,
      tools,
      brand: machine.brand,
      // The machine's cooling on every tool (you: HAAS-2 and HAAS-4 air, the others coolant).
      coolant: cooling === 'air' ? 'air' : 'flood',
      name: name.slice(0, 40),
      author: user?.username,
      raw,
      margins,
      stops: stop1 || Object.values(laterX).some((x) => x.stop) ? Array.from({ length: Math.max(0, ...Object.keys(laterX).map(Number)) + 1 }, (_, k) => (k === 0 ? stop1 || null : (laterX[k]?.stop ?? null))) : undefined,
      spacersY: Object.values(laterX).some((x) => x.y !== undefined) ? Array.from({ length: Math.max(0, ...Object.keys(laterX).map(Number)) + 1 }, (_, k) => laterX[k]?.y ?? null) : undefined,
      // The sides asked for clamping 3 and on (item 8); every clamping that carries a choice named by its side (as
      // made, when not asked), so its choices go with that side (program.ts: choiceAt).
      sides: (() => {
        // A clamping turned by hand asks for the side its turn puts up.
        const asked = [...Object.entries(laterX).filter(([k, x]) => Number(k) >= 2 && x.side).map(([k]) => Number(k)), ...Object.keys(turned).map(Number).filter((k) => k >= 2)];
        if (!asked.length) return undefined;
        const carried = [...Object.keys(laterX), ...Object.keys(later)].map(Number).filter((k) => k >= 2);
        const made = run.state === 'done' ? run.result.setups : [];
        return Array.from({ length: Math.max(...asked, ...carried) - 1 }, (_, j) => (turned[j + 2] ? upOf(turned[j + 2].R) : undefined) ?? laterX[j + 2]?.side ?? made[j + 2]?.side ?? '').filter(Boolean);
      })(),
      turns: Object.values(laterX).some((x) => x.flip || x.quarter)
        ? Array.from({ length: Math.max(0, ...Object.keys(laterX).map(Number)) + 1 }, (_, k) => (laterX[k]?.flip || laterX[k]?.quarter ? { ...(laterX[k].flip ? { flip: laterX[k].flip } : {}), ...(laterX[k].quarter ? { quarter: laterX[k].quarter } : {}) } : null))
        : undefined,
      spacersYp: Y_PLUS && Object.values(laterX).some((x) => x.yp) ? Array.from({ length: Math.max(0, ...Object.keys(laterX).map(Number)) + 1 }, (_, k) => laterX[k]?.yp ?? null) : undefined,
      clamps: clamp1 !== null || Object.keys(later).length ? Array.from({ length: Math.max(0, ...Object.keys(later).map(Number)) + 1 }, (_, k) => (k === 0 ? clamp1 : (later[k] && 'cale' in later[k] ? later[k].cale : null))) : undefined,
      jawRests: Object.values(later).some((h) => 'jaw' in h) ? Array.from({ length: Math.max(0, ...Object.keys(later).map(Number)) + 1 }, (_, k) => (later[k] && 'jaw' in later[k] ? later[k].jaw : null)) : undefined,
      // The thickness where the parallels touch the part, typed or picked (you; "UNTERLAGE IN EP").
      steps: Object.values(later).some((h) => 'step' in h) ? Array.from({ length: Math.max(0, ...Object.keys(later).map(Number)) + 1 }, (_, k) => (later[k] && 'step' in later[k] ? later[k].step : null)) : undefined,
      partType,
      // Clamping 1 turned by hand: the side its turn puts up (the turn itself in frames).
      orient: turned[0] ? { side: upOf(turned[0].R), spin: false } : { side: chosen.side, spin: chosen.spin },
      frames: Object.keys(turned).length ? Array.from({ length: Math.max(...Object.keys(turned).map(Number)) + 1 }, (_, k) => turned[k]?.R ?? null) : undefined,
      sideStock: sideStock || undefined,
      exclude: with_.exclude,
      prefer: with_.prefer,
      second: turned[1] ? upOf(turned[1].R) : second && second.side !== opposite(chosen.side) ? second.side : undefined,
      cuts: edits,
      toolDb: db.db,
      skip: skips,
      finish: finishTris.length ? finishTris : undefined,
      white: partType === 'topPlate' ? white : undefined,
      limits: { maxRpm: machine.maxRpm ?? DEFAULT_LIMITS.maxRpm, maxFeed: machine.maxFeed ?? DEFAULT_LIMITS.maxFeed },
      speeds: { rapid: machine.rapid ?? speeds.rapid, toolChange: machine.toolChange ?? speeds.toolChange },
    };
    w.onmessage = (e: MessageEvent<CamMessage>) => {
      const m = e.data;
      if (m.type === 'progress') return setRun({ state: 'busy', done: m.done, of: m.of });
      if (m.type === 'prepared') return;
      if (m.type === 'live') return setLive((l) => liveStep(l, m.e));
      // Changes by hand, checked again on the plan the worker kept.
      if (m.type === 'edited') {
        const sent = sentEdits.current.shift();
        if (sent) checkedEdits.current = { edits: sent.edits, order: sent.order };
        setChecking(false);
        // The operation just changed stays picked, under its new tool if its tool was changed (its key does not change).
        const key = following.current;
        following.current = null;
        const i = key ? m.result.setups.findIndex((s) => s.ops.some((o) => o.key === key)) : -1;
        if (i >= 0) setSel({ kind: 'tool', i, code: m.result.setups[i].ops.find((o) => o.key === key)!.code, op: key! });
        return setRun({ state: 'done', result: m.result });
      }
      if (m.type === 'error') {
        const refused = sentEdits.current.shift();
        if (refused) {
          // A change by hand refused (out of range, a tool gone): back to the edits the program shown was checked with;
          // that program and the plan the worker keeps stay, and the refused change is neither listed nor made again.
          const back = checkedEdits.current;
          setOpEdits(back.edits);
          editsRef.current = back.edits;
          setOpOrder(back.order);
          orderRef.current = back.order;
          following.current = null;
          setChanges((l) => l.filter((c) => !c.now || c.id <= refused.id));
          setChecking(false);
          setEditRefused(true);
          return;
        }
        w.terminate();
        worker.current = null;
        setChecking(false);
        endRemake();
        return setRun({ state: 'error', error: m.error });
      }
      // Made: the worker stays, holding the plan, for changes by hand (items 10 and 11); a new make drops the old ones.
      endRemake();
      setRun({ state: 'done', result: m.result });
      plain.current = m.result;
      checkedEdits.current = { edits: {}, order: {} };
      sentEdits.current = [];
      setEditRefused(false);
      setMadeTurns(turnsAsked.current);
      // The tools changed by hand, on every operation of the new plan that still uses the old tool in that clamping.
      const swapped: Record<string, OpEdit> = {};
      for (const [k, tool] of Object.entries(swapsNow)) {
        const [side, code] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)];
        for (const st of m.result.setups) if (st.side === side) for (const o of st.ops) if (o.code === code) swapped[o.key] = { tool };
      }
      // A tool changed by hand keeps its place in the order asked: made again with the one that took its paths, the
      // operations of that one stand there now.
      for (const [k, tool] of Object.entries(swapsNow)) {
        const [side, code] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)];
        const list = orderRef.current[side];
        const st = m.result.setups.find((x) => x.side === side);
        if (!list || !st || !tool.code) continue;
        const keys = new Set(st.ops.map((o) => o.key));
        const moved = list.map((key) => {
          const now = key.replace(`|${code}|`, `|${tool.code}|`);
          return !keys.has(key) && keys.has(now) ? now : key;
        });
        if (moved.some((key, n) => key !== list[n])) orderRef.current = { ...orderRef.current, [side]: moved };
      }
      if (orderRef.current !== opOrder) setOpOrder(orderRef.current);
      // The order dragged, for the operations this program still has in that clamping.
      const ordered = Object.entries(orderRef.current).some(([side, keys]) => m.result.setups.some((st) => st.side === side && st.ops.some((o) => keys.includes(o.key))));
      if (carrying || Object.keys(swapped).length || ordered) {
        // Changes by hand go on with the new program where their operation is the same cut (its lines as made match:
        // a key only counts operations of one name and tool, so after a re-plan it can name another cut) in a clamping
        // with the same side and frame (a move is in the clamping's own X, Y, Z: turned, it would cut elsewhere, a
        // review found); the rest are said gone.
        const clampingOf = (r: CamSummary, key: string) => r.setups.find((x) => x.ops.some((o) => o.key === key));
        const same = (key: string) => {
          const [a, b] = [before && clampingOf(before, key), clampingOf(m.result, key)];
          const sig = (x: CamSummary['setups'][number]) => x.ops.find((o) => o.key === key)!.sig;
          return !!a && !!b && a.side === b.side && a.R.every((v, k) => Math.abs(v - b.R[k]) < 1e-9) && sig(a) === sig(b);
        };
        const kept = Object.fromEntries(Object.entries(carrying ?? {}).filter(([k]) => same(k)));
        const keep: Record<string, OpEdit> = { ...kept };
        for (const [k, e] of Object.entries(swapped)) keep[k] = { ...keep[k], ...e };
        if (Object.keys(keep).length || ordered) applyEdits(keep, '');
        else setOpEdits({});
        setEditsDropped(swapsLost || Object.keys(kept).length < Object.keys(carrying ?? {}).length);
      } else
        setOpEdits((was) => {
          if (Object.keys(was).length || swapsLost) setEditsDropped(true);
          return {};
        });
      setAccepted(false);
      // A later clamping's hold the program refused (its note says so) is asked no more: its panel shows the hold used,
      // the 3D view no longer previews it, and the next make does not ask it again.
      setLater((l) => {
        const kept = Object.fromEntries(Object.entries(l).filter(([k, h]) => !m.result.notes.some((n) => n.setup === Number(k) + 1 && refusedHold(n, h))));
        return Object.keys(kept).length === Object.keys(l).length ? l : kept;
      });
      // A part record for the learning records (Admin > Data). Best effort; only programs that
      // passed every check (a failed run would teach the wrong thing).
      if (m.lesson && passed(m.result)) void api('/toolpath/lessons', { body: { kind: 'part', fileName, start: m.result.match, match: m.result.match, data: m.lesson }, timeoutMs: 120_000 }).catch(() => {});
    };
    setRun({ state: 'busy', done: 0, of: 1 });
    // What a removed operation cut: kept from the program it was in, to show where it was.
    setGhosts((g) => [...g.filter((p) => p.key && skips.includes(p.key) && !live.paths.some((q) => q.key === p.key)), ...live.paths.filter((p) => p.key && skips.includes(p.key))]);
    setLive(NO_LIVE);
    turnsAsked.current = Object.fromEntries(Object.entries(laterX).map(([k, x]) => [k, { flip: x.flip, quarter: x.quarter }]));
    w.postMessage(request);
  };

  const generateRef = useRef(generate);
  generateRef.current = generate;
  const result = run.state === 'done' ? run.result : null;
  // Leaving CAM AI (back, or Send to the remapper) keeps nothing of it: with a program made or being made, asked first.
  const [leaveAsk, setLeaveAsk] = useState<{ go: () => void; send: boolean } | null>(null);
  const leave = (go: () => void, send = false) => (result || busy ? setLeaveAsk({ go, send }) : go());
  // The machine's own program, as Send and Process in the remapper give it (forMachine).
  const engineId = machine ? engineMachineId(currentRegion().id, machine) : '';
  const download = () => {
    if (!result || !machine || checking || waiting || handTool || badNumber !== undefined || !passed(result, handEdited && accepted)) return;
    // The material it was cut as (for OTHER the chosen family), as the program's header names it.
    downloadBlob(fileName, new Blob([forMachine(result.code, engineId, fileName, templatesFor ?? undefined)], { type: 'text/plain' }));
  };
  const storeSideStock = (v: number) => {
    setSideStock(v);
    try {
      localStorage.setItem(SIDE_STOCK_KEY, String(v));
    } catch {
      /* a convenience: the default works without it */
    }
  };
  // The part type and the side stock are what the program is made for: changed on a program made, listed until it is
  // made again (Download and Send wait), Undo back to what it was made with.
  const saveSideStock = (v: number) => {
    const ok = Number.isFinite(v) ? Math.min(0.5, Math.max(0, v)) : 0;
    if (result && ok !== sideStock && !changes.some((c) => c.sideStock !== undefined)) {
      const was = sideStock;
      addChange({ label: t('camAi.changes.sideStock', { mm: fmt(was, 2) }), sideStock: was, undo: () => storeSideStock(was) });
    }
    storeSideStock(ok);
  };
  const choosePartType = (v: PartType) => {
    const was = partType;
    setPartType(v);
    if (result && v !== was) addChange({ label: t('camAi.changes.partType', { type: t(`camAi.part.types.${v}`) }), undo: () => setPartType(was) });
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
    // Which faces are walls depends on how the part lies: picks for another layout would be stale.
    if (i !== layout) setFinishWalls([]);
    setSecond(null);
    setLocked2(false);
    // Parallels chosen for another way of lying are not for this one, nor turns by hand.
    if (i !== layout) {
      setClamp1(null);
      setStop1(0);
      setLater({});
      setLaterX({});
      setTurned({});
    }
    if (prep) setTotals(prep.layouts[i].size.map((v, k) => String(Math.round((v + AUTO_EXCESS[k]) * 10) / 10)));
  };

  // The browser's selected item, what the properties panel edits.
  const [sel, setSel] = useState<Sel>({ kind: 'part' });
  // Leaving the clamping whose settings are open closes them.
  useEffect(() => {
    if (setupOpen !== null && (sel.kind !== 'setup' || sel.i !== setupOpen)) setSetupOpen(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel.kind, sel.kind === 'setup' ? sel.i : -1]);
  // A program opened from a file (an engineer's): shown and changed by hand in its own view (CamOpened).
  const [opened, setOpened] = useState<{ name: string; code: string } | null>(null);
  const [openError, setOpenError] = useState(false);
  const programRef = useRef<HTMLInputElement>(null);
  const openProgram = async (file: File | undefined) => {
    if (!file) return;
    setOpenError(false);
    const text = await file.text();
    // A program: G-code lines with moves, not a 3D model or a document.
    if (file.size > 8_000_000 || !/\bG0?[0123]\b/.test(text) || /\u0000/.test(text)) return setOpenError(true);
    setOpened({ name: file.name, code: text.replace(/\r\n?/g, '\n') });
  };
  // The panels (you: collapsed with [ and ], remembered); under 1400 px the inspector, under 1100 px the tools, are drawers.
  const [leftOpen, setLeftOpen] = useStoredFlag('cnc-camai-tools', true);
  const [rightOpen, setRightOpen] = useStoredFlag('cnc-camai-inspector', true);
  const [leftDrawer, setLeftDrawer] = useState(false);
  const [rightDrawer, setRightDrawer] = useState(false);
  const width = useWindowWidth();
  const wide = width >= 1400;
  const narrow = width < 1100;
  // The clamping whose tools the list shows, when no tool or clamping is picked.
  const [opTab, setOpTab] = useState(0);
  // The NX view in the simulation (every path over the finished part).
  const [nx, setNx] = useState(false);
  // A tool right-clicked: its card opens on changing it.
  const [swapAsk, setSwapAsk] = useState<string | null>(null);
  // Measuring the model in the view, as in a CAD program (before or after a program is made).
  const [measuring, setMeasuring] = useState(false);
  // A tool picked in a made program: the simulation at its first move in that clamping (a new pick asks again).
  const focusSeq = useRef(0);
  // Or a later clamping picked: the part as the clampings before left it, the finished part over it (you, Beta 2).
  const focusTool = useMemo(() => {
    if (run.state !== 'done') return null;
    // Clamping 1 too (its parallels editor opens only from its settings now).
    if (sel.kind === 'setup' && run.result.setups[sel.i]) return { setup: sel.i, key: ++focusSeq.current };
    if (sel.kind !== 'tool') return null;
    const op = run.result.setups[sel.i]?.ops.find((o) => o.code === sel.code);
    return op ? { setup: sel.i, tool: op.tool, key: ++focusSeq.current } : null;
  }, [run, sel]);
  const [simFocus, setSimFocus] = useState<SimFocus | null>(null);
  useEffect(() => {
    if (focusTool) setSimFocus(focusTool);
  }, [focusTool]);
  // [ and ] fold the tool list and the inspector away (never while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey || (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)))) return;
      if (e.key === '[') (narrow ? setLeftDrawer((x) => !x) : setLeftOpen(!leftOpen));
      if (e.key === ']') (wide ? setRightOpen(!rightOpen) : setRightDrawer((x) => !x));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  // The clamping editor: clamping 1 picked and confirmed, its blank known, nothing being made.
  // Measuring before a program keeps the vise: its bed, jaw faces and tops, and the stop are planes to measure to
  // (item 17). Once made, Measure goes to the simulation, as before.
  // Holds asked for and not made yet, by clamping: the simulation draws them whatever is picked (you: a tool of OP20
  // picked, or OP10 and back, kept the old parallels). Clamping 1's from its panel, the later ones' from theirs.
  const previews = useMemo(() => {
    const out: Record<number, { cale?: number; stop?: number; y?: number; yp?: number }> = {};
    if (run.state !== 'done') return out;
    for (const k of new Set([...Object.keys(later), ...Object.keys(laterX)].map(Number))) {
      if (k === 0 || !(later[k] || laterX[k])) continue;
      const h = later[k];
      out[k] = { cale: h && 'cale' in h ? (h as { cale: number }).cale : undefined, stop: laterX[k]?.stop ?? 0, y: laterX[k]?.y, yp: laterX[k]?.yp ?? 0 };
    }
    const made0 = run.result.setups[0];
    const stop0 = Number(made0?.notes.join(' ').match(/(\d+) MM ZWISCHENLAGE IN X-/)?.[1] ?? 0);
    if (made0 && ((clamp1 !== null && clamp1 !== made0.cale) || laterX[0] || stop1 !== stop0)) out[0] = { cale: clamp1 ?? undefined, stop: stop1, y: laterX[0]?.y, yp: laterX[0]?.yp ?? 0 };
    return out;
  }, [run, later, laterX, clamp1, stop1]);
  const clampMode = sel.kind === 'setup' && sel.i === 0 && locked1 && !!raw && !busy && (!measuring || !result) && cales1.length > 0 && (!result || setupOpen === 0);
  const [measureMode, setMeasureMode] = useState<MeasureMode>('faces');
  const [measured, setMeasured] = useState<Measurement>(null);
  const [dialog, setDialog] = useState(false);
  // The shop's tool database (item 20): loaded once, fresh again each time its dialog opens.
  const [toolDb, setToolDb] = useState<StoredToolDb>({ db: {}, by: {} });
  // The tool database as it is now, for changes by hand made after the program (a tool added since).
  const toolDbRef = useRef(toolDb);
  toolDbRef.current = toolDb;
  const [dbOpen, setDbOpen] = useState(false);
  useEffect(() => {
    loadToolDb().then(setToolDb, () => {});
  }, []);
  // Cutting values typed and not yet in the program: it must be made again before it goes out.
  const [draft, setDraft] = useState<Record<string, CutEdit>>({});
  const changed = Object.keys({ ...draft, ...cuts }).filter((k) => JSON.stringify(draft[k] ?? {}) !== JSON.stringify(cuts[k] ?? {}));
  const toolName = useToolName();
  // A part changed by hand may be accepted as it is (the tick), never what could hit the machine (safe()).
  const handEdited = Object.keys(opEdits).length > 0 || Object.values(opOrder).some((c) => c.length > 0);
  // A tool changed by hand has no machine number: only the remapper gives it one (Send), never Download.
  const handTool = !!result?.setups.some((s) => s.ops.some((o) => o.code.endsWith('_HAND')));
  // The owner's rule: T and H a Haas takes (1-200), else no file (the remapper gives the tool a machine number).
  const badNumber = result ? badToolNumber(result, machine?.brand) : undefined;
  const verdict = useVerdictOrNull(result, changed.length + pendingSkips, handEdited && accepted);
  const ok = !!verdict?.ok;
  // What still stands before the program can be made (the status bar says it).
  const next = !prep ? 'model' : !partType ? 'partType' : !locked1 ? 'setup1' : !locked2 ? 'setup2' : !raw || under1 === 'tooThin' || topThin ? 'stock' : !machine || !tools.length || wrongCooling ? 'machine' : !templatesFor ? 'material' : refused1 ? 'clamp' : null;
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
  // Another machine, material or stock: the program made (its tools, speeds, coolant, blank) is not for it.
  const choose = (set: () => void) => {
    set();
    if (result) {
      setRun({ state: 'idle' });
      // Later clampings' parallels were chosen on that program: their panels go with it.
      resetLater();
    }
  };
  // The clamping editor (3D view, keys and buttons): taller or shorter parallels (none below the lowest), the part
  // back or toward the operator between the jaws, the moving jaw open or closed (pushing the part back to the fixed one).
  const refuse = () => setFlash((f) => f + 1);
  const clampAct = (act: ClampAct) => {
    if (act === 'up' || act === 'down') {
      const v = stepCale(cale1, act === 'up' ? 1 : -1);
      if (v === null) return refuse();
      // Later clampings hold what this one leaves: their choices go. A program made stays until it is made again
      // (one wheel notch must not throw it away), with Undo and Make again offered.
      holdChanged(v ? t('camAi.changes.parallels', { n: 1, mm: fmt(v, 0) }) : t('camAi.changes.table', { n: 1 }));
      setClamp1(v);
      resetLater();
      // The next taller parallels, faintly, for a moment.
      window.clearTimeout(hintTimer.current);
      setNextHint(stepCale(v, 1) ?? undefined);
      hintTimer.current = window.setTimeout(() => setNextHint(undefined), 1100);
      return;
    }
    const next = jawMove(jaw, act);
    if (next) setJaw(next);
    else refuse();
  };
  // A click on a wall: picked, or taken off again.
  const toggleWall = (wall: number[]) => choose(() => setFinishWalls((now) => (now.some((w) => w[0] === wall[0]) ? now.filter((w) => w[0] !== wall[0]) : [...now, wall])));
  // Make again with every change listed: a shop tool picked preferred, operations deleted or removed left out, typed
  // values used; changes by hand to operations (moved, deeper, a size typed) go on with the new program where their
  // operation is still in it.
  const makeAgain = () => {
    // The latest choice for each tool wins; back to CAM AI's tool (prefer '') cancels the ones before it.
    const picked = new Map<string, string>();
    for (const c of changes) if (c.swap) picked.set(c.swap.exclude, c.swap.prefer);
    // Preferred only, the old tool not left out (you: a tool change always applies; where the plan keeps the old tool,
    // the new one takes its paths, toolSwaps).
    const pr = [...picked.values()].filter(Boolean);
    const nextSwap = pr.length ? { exclude: swap.exclude, prefer: [...new Set([...swap.prefer, ...pr])] } : swap;
    const dropped = Object.assign({}, ...changes.map((c) => c.skip ?? {})) as Record<string, string>;
    const nextSkip = [...new Set([...skipDraft, ...Object.keys(dropped)])];
    if (Object.keys(dropped).length) setSkipLabels((l) => ({ ...l, ...dropped }));
    const hand: Record<string, OpEdit> = {};
    for (const [k, e] of Object.entries(opEdits)) {
      const rest: OpEdit = { ...e };
      delete rest.off;
      // A tool changed by hand comes back by its clamping and the tool it replaced (toolSwaps), never by this cut.
      delete rest.tool;
      if (Object.keys(rest).length) hand[k] = rest;
    }
    carry.current = Object.keys(hand).length ? hand : null;
    setChanges([]);
    setSwap(nextSwap);
    setCuts(draft);
    setSkipDraft(nextSkip);
    setSkip(nextSkip);
    generate(nextSwap, draft, nextSkip);
  };
  const shownChanges = changes.filter((c) => (c.cuts === undefined || changed.includes(c.cuts)) && (c.removed === undefined || (skipDraft.includes(c.removed) && !skip.includes(c.removed))));
  // You: every change reaches the program downloaded. Those that wait for Make again lock Download and Send until then.
  const waiting = shownChanges.some((c) => !c.now);
  const undoLast = () => {
    const c = [...shownChanges].reverse().find((x) => x.undo);
    if (!c) return;
    setChanges((l) => l.filter((x) => x.id !== c.id));
    c.undo!();
  };
  // Removing an operation (or keeping it after all): it stays in the browser, struck through, until the program is made again.
  const remember = (i: number, ops: CamSummary['setups'][number]['ops']) => {
    const side = result?.setups[i]?.side;
    if (side) setGone((g) => ({ ...g, ...Object.fromEntries(ops.map((o) => [o.key, { side, code: o.code, tool: o.tool, type: o.type, diameter: o.diameter, length: o.length, purpose: o.purpose }])) }));
  };
  const toggleOp = (o: { key: string; purpose: Purpose; tool: number }, remove: boolean) => {
    if (remove && result) {
      const i = result.setups.findIndex((x) => x.ops.some((y) => y.key === o.key));
      if (i >= 0) remember(i, result.setups[i].ops.filter((y) => y.key === o.key));
    }
    setSkipDraft((d) => (remove ? [...new Set([...d, o.key])] : d.filter((k) => k !== o.key)));
    const label = `T${o.tool} · ${t(`camAi.purpose.${o.purpose}`)} (${o.key.split('|')[0]})`;
    if (remove) {
      setSkipLabels((l) => ({ ...l, [o.key]: label }));
      addChange({ label: t('camAi.changes.removed', { what: label }), removed: o.key, undo: () => setSkipDraft((d) => d.filter((k) => k !== o.key)) });
    } else setChanges((l) => l.filter((c) => c.removed !== o.key));
  };
  // A tool deleted from a clamping (item 4): its operations there taken out of the program as made, checked again;
  // the bar offers Undo, or Make again (CAM AI plans without them).
  const dropTool = (i: number, code: string) => {
    const ops = result?.setups[i]?.ops.filter((o) => o.code === code) ?? [];
    if (!ops.length) return;
    const was = opEdits;
    const next: Record<string, OpEdit> = { ...opEdits };
    for (const o of ops) next[o.key] = { off: true };
    remember(i, ops);
    setSel({ kind: 'setup', i });
    applyEdits(next, ops[0].key);
    addChange({
      now: true,
      label: t('camAi.bar.deleted', { tool: ops[0].tool, n: i + 1 }),
      undo: () => applyEdits(was, ops[0].key),
      // Made again: CAM AI plans without them.
      skip: Object.fromEntries(ops.map((o) => [o.key, `T${o.tool} · ${t(`camAi.purpose.${o.purpose}`)} (${o.key.split('|')[0]})`])),
    });
  };
  // A tool moved in its clamping's list (you: drag and drop, or Alt + arrows): its operations there run in that place,
  // checked again (an order no check covers locks it, program.ts reorderOps); kept after Make again for its tools.
  // to: the place it goes before (0 to the number of tools).
  const moveTool = (i: number, code: string, to: number) => {
    const s = result?.setups[i];
    if (!s || busy) return;
    // From the order last asked for (a move made before the one before it is checked builds on it), as the list shows it.
    const seq = inOrder(s.side, s.ops, orderRef.current);
    const list = [...new Set(seq.map((o) => o.code))];
    const from = list.indexOf(code);
    if (from < 0 || to < 0 || to > list.length) return;
    // Only this tool's operations move, together, before the first of the tool now at that place; the others keep
    // their order (a tool used in two places stays in both).
    const rows = list.filter((c) => c !== code);
    const at = to > from ? to - 1 : to;
    const rest = seq.filter((o) => o.code !== code);
    const cut = at < rows.length ? rest.findIndex((o) => o.code === rows[at]) : rest.length;
    const next = [...rest.slice(0, cut), ...seq.filter((o) => o.code === code), ...rest.slice(cut)].map((o) => o.key);
    if (next.every((k, n) => k === seq[n].key)) return;
    const was = orderRef.current;
    const order = { ...was, [s.side]: next };
    setOpOrder(order);
    applyEdits(editsRef.current, '', order);
    addChange({
      now: true,
      label: t('camAi.bar.moved', { tool: s.ops.find((o) => o.code === code)!.tool, n: i + 1 }),
      undo: () => {
        setOpOrder(was);
        applyEdits(editsRef.current, '', was);
      },
    });
  };
  // A turn button pressed for clamping i (you): added to its presses before; the clampings after it hold what it leaves,
  // so their choices go (as for any hold choice). Undo steps back one press.
  const turnBy = (i: number, press: string) => {
    const s = result?.setups[i];
    if (!s) return;
    const was = { later, laterX, turned };
    const now = turned[i] ?? { R: s.R as Mat3, presses: [] };
    const keep = <T,>(l: Record<number, T>, upTo: number) => Object.fromEntries(Object.entries(l).filter(([k]) => Number(k) <= upTo)) as Record<number, T>;
    setTurned({ ...keep(turned, i - 1), [i]: { R: mul3(QUARTER[press], now.R), presses: [...now.presses, press] } });
    setLater((l) => keep(l, i));
    setLaterX((l) => keep(l, i));
    addChange({
      label: t('camAi.changes.turned', { op: (i + 1) * 10, turn: `${press[0]} ${press[1] === '+' ? '+90°' : '−90°'}` }),
      undo: () => {
        setLater(was.later);
        setLaterX(was.laterX);
        setTurned(was.turned);
      },
    });
  };
  const turnOwn = (i: number) => {
    const was = turned;
    setTurned(Object.fromEntries(Object.entries(turned).filter(([k]) => Number(k) < i)));
    addChange({ label: t('camAi.changes.turnOwn', { op: (i + 1) * 10 }), undo: () => setTurned(was) });
  };
  // Deleted operations still deleted (by hand now, or for the next program made), and bringing them back.
  const isGone = (k: string) => !!opEdits[k]?.off || skipDraft.includes(k);
  const restore = (keys: string[], what: string) => {
    const offs = keys.filter((k) => opEdits[k]?.off);
    if (offs.length) {
      const next = { ...opEdits };
      for (const k of offs) delete next[k];
      applyEdits(next, '');
      setChanges((l) => l.filter((c) => !c.skip || !Object.keys(c.skip).some((k) => offs.includes(k))));
    }
    const drafted = keys.filter((k) => skipDraft.includes(k));
    if (drafted.length) {
      setSkipDraft((d) => d.filter((k) => !drafted.includes(k)));
      setChanges((l) => l.filter((c) => c.removed === undefined || !drafted.includes(c.removed)));
      // Gone from the program as made: back the next time it is made.
      if (drafted.some((k) => skip.includes(k))) addChange({ label: t('camAi.changes.restored', { what }), undo: () => setSkipDraft((d) => [...new Set([...d, ...drafted])]) });
    }
  };
  // A clamping's deleted tools no operation of which is left in the program shown: crossed-out rows (by tool).
  const goneTools = (i: number) => {
    const s = result?.setups[i];
    if (!s) return [];
    const live = new Set(s.ops.map((o) => o.code));
    const by = new Map<string, { g: GoneOp; keys: string[] }>();
    for (const [k, g] of Object.entries(gone)) {
      if (g.side !== s.side || live.has(g.code) || !(isGone(k) || skip.includes(k))) continue;
      const e = by.get(g.code) ?? { g, keys: [] };
      e.keys.push(k);
      by.set(g.code, e);
    }
    return [...by.values()];
  };
  // Changes by hand, checked again on the plan the worker kept (the operation `key` stays picked).
  const applyEdits = (next: Record<string, OpEdit>, key: string, order = orderRef.current) => {
    setOpEdits(next);
    editsRef.current = next;
    orderRef.current = order;
    setEditsDropped(false);
    setEditRefused(false);
    setAccepted(false);
    setChecking(true);
    following.current = key;
    sentEdits.current.push({ edits: next, order, id: changeId.current });
    worker.current?.postMessage({ type: 'edit', edits: next, order, toolDb: toolDbRef.current.db });
  };
  // The browser's setups: the two picked ones before a program, the program's after.
  const setupNodes = result ? result.setups.map((s, i) => ({ i, side: s.side })) : chosen ? [{ i: 0, side: chosen.side }, ...(locked1 ? [{ i: 1, side: side2 }] : [])] : [];
  const paths =
    sel.kind === 'tool'
      ? live.paths.filter((p) => p.setup === sel.i && p.tool === sel.code && (!sel.op || p.key === sel.op))
      : sel.kind === 'setup'
        ? live.paths.filter((p) => p.setup === sel.i)
        : live.paths;


  // The clampings as the step chips and tabs show them: "2 · 180° X · 28".
  const stepName = (i: number) => {
    const s = result?.setups[i];
    if (!s) return { n: i + 1, turn: setupNodes.find((x) => x.i === i)?.side ?? '', rest: '' };
    const turn = s.notes.join(' ').match(/(\d+)\s*GRAD\s*UM\s*([XYZ])/);
    const rest = s.notes.some((x) => /POM-NEST/.test(x)) ? t('camAi.sim.nest') : s.notes.some((x) => /SUR L'ETAU/.test(x)) ? t('camAi.sim.onJaw') : s.cale === 0 ? t('camAi.sim.onTable') : fmt(s.cale, 0);
    return { n: i + 1, turn: i === 0 ? t('camAi.ws.vise') : turn ? `${turn[1]}° ${turn[2]}` : s.side, rest };
  };
  const parallelsText = (i: number) => {
    const s = result?.setups[i];
    if (!s) return '';
    if (s.notes.some((x) => /POM-NEST/.test(x))) return t('camAi.sim.nest');
    if (s.notes.some((x) => /SUR L'ETAU/.test(x))) return t('camAi.sim.onJaw');
    // Asked for the next make: drawn so in the 3D view (a preview), and said so here.
    const asked = later[i] && 'cale' in later[i] ? (later[i] as { cale: number }).cale : undefined;
    if (asked !== undefined) return `${asked === 0 ? t('camAi.sim.onTable') : t('camAi.sim.parallels', { mm: fmt(asked, 0) })} · ${t('camAi.hold.preview')}`;
    return s.cale === 0 ? t('camAi.sim.onTable') : t('camAi.sim.parallels', { mm: fmt(s.cale, 0) });
  };
  // The tools in program order, one colour each (CamSim gives the same).
  const toolColor = useMemo(() => {
    const order: number[] = [];
    for (const s of result?.setups ?? []) for (const o of s.ops) if (!order.includes(o.tool)) order.push(o.tool);
    return (n: number) => SIM_COLORS[Math.max(0, order.indexOf(n)) % SIM_COLORS.length];
  }, [result]);
  const runLabel = (setup: number, toolNo: number | null) => {
    const ops = result?.setups[setup]?.ops.filter((o) => o.tool === toolNo) ?? [];
    if (!ops.length) return toolNo === null ? '' : `T${toolNo}`;
    return `T${toolNo} · ${t(`camAi.tools.${ops[0].type}`, { defaultValue: ops[0].type })} — ${[...new Set(ops.map((o) => t(`camAi.purpose.${o.purpose}`)))].join(', ')}`;
  };
  const opNow = sel.kind === 'setup' || sel.kind === 'tool' ? sel.i : opTab;
  // What the checks say, row by row (the status chip's popover).
  const checks = result
    ? [
        { label: t('camAi.ws.check.match'), value: t('camAi.percent', { v: fmt(result.match * 100, 2) }), bad: result.match < 0.99 },
        { label: t('camAi.ws.check.size'), value: t(result.sized ? 'camAi.ws.check.sizeOk' : 'camAi.ws.check.sizeBad'), bad: !result.sized },
        { label: t('camAi.ws.check.collisions'), value: result.collisions - result.stops ? String(result.collisions - result.stops) : t('camAi.ws.check.none'), bad: result.collisions - result.stops > 0 },
        { label: t('camAi.ws.check.cales'), value: result.cales ? String(result.cales) : t('camAi.ws.check.none'), bad: result.cales > 0 },
        { label: t('camAi.ws.check.stops'), value: result.stops ? String(result.stops) : t('camAi.ws.check.none'), bad: result.stops > 0 },
        { label: t('camAi.ws.check.misplaced'), value: result.misplaced ? String(result.misplaced) : t('camAi.ws.check.none'), bad: result.misplaced > 0 },
        { label: t('camAi.ws.check.gouge'), value: result.gouge >= 1 ? `${fmt(result.gouge, 0)} mm³` : t('camAi.ws.check.none'), bad: result.gouge >= 1 && !accepted },
        { label: t('camAi.ws.check.hold'), value: t(result.setups.every((s) => s.physics.ok) ? 'camAi.ws.check.yes' : 'camAi.ws.check.no'), bad: !result.setups.every((s) => s.physics.ok) },
        { label: t('camAi.ws.check.cutting'), value: t(result.setups.some((s) => s.ops.some((o) => o.unsafe)) ? 'camAi.ws.check.no' : 'camAi.ws.check.yes'), bad: result.setups.some((s) => s.ops.some((o) => o.unsafe)) },
      ]
    : [];
  // Changes waiting for Make again (any kind: typed, removed, a clamping) are no issue: the chip says they wait, alike for all.
  const pendingMake = waiting || changed.length + pendingSkips > 0;
  // A lock with no row of its own (a hold refused, the floor hit) stays an issue: only the changes waiting are not.
  const issues = Math.max(result && !passed(result, handEdited && accepted) ? 1 : 0, checks.filter((c) => c.bad).length);
  const collapseBtn = 'no-glass w-8 h-8 grid place-items-center rounded-[8px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[rgba(var(--ov),0.08)]';
  const barBtn = 'no-glass h-8 shrink-0 whitespace-nowrap inline-flex items-center gap-2 px-3 rounded-[8px] border border-[var(--border-subtle)] text-[13px] text-[var(--text-primary)] hover:bg-[rgba(var(--ov),0.08)] disabled:opacity-40 disabled:hover:bg-transparent';
  const menuItem = 'no-glass w-full flex items-center gap-2.5 h-9 px-2.5 rounded-[6px] text-[13px] text-left text-[var(--text-primary)] hover:bg-[rgba(var(--ov),0.08)] disabled:opacity-40';
  const rowAct = 'no-glass h-8 min-w-8 px-2 inline-flex items-center justify-center gap-1.5 rounded-[6px] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[rgba(var(--ov),0.08)] disabled:opacity-50';
  const row = (active: boolean) => `no-glass w-full h-11 flex items-center gap-2.5 px-2 rounded-[8px] text-left transition-colors ${active ? 'bg-[var(--accent-primary)]/15' : 'hover:bg-[rgba(var(--ov),0.06)]'}`;
  const toolsOpen = narrow ? leftDrawer : leftOpen;
  const inspectorOpen = wide ? rightOpen : rightDrawer;
  const toggleTools = () => (narrow ? setLeftDrawer((x) => !x) : setLeftOpen(!leftOpen));
  const toggleInspector = () => (wide ? setRightOpen(!rightOpen) : setRightDrawer((x) => !x));

  const toolList = (
    <>
      {result ? (
        <>
          <div className="flex items-center gap-2 p-2">
            <div role="tablist" aria-label={t('camAi.ws.clampings')} className="flex-1 grid gap-0.5 p-0.5 rounded-[8px] border border-[var(--border-subtle)] bg-[rgba(var(--ov),0.03)]" style={{ gridTemplateColumns: `repeat(${result.setups.length}, minmax(0, 1fr))` }}>
              {result.setups.map((_, i) => (
                <div key={i} className="group relative grid">
                <button type="button" role="tab" aria-selected={opNow === i} onClick={() => { setOpTab(i); setSel({ kind: 'setup', i }); }} className={`no-glass h-8 rounded-[6px] text-[13px] ${opNow === i ? 'bg-[rgba(var(--ov),0.12)] text-[var(--text-primary)] font-semibold' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}>
                  OP{(i + 1) * 10}
                </button>
                {/* Its settings on hover (you): parallels and how the part lies; also from the keyboard. */}
                {/* A span holds its place: every button is position: relative (index.css), over Tailwind's absolute. */}
                <span className="absolute right-0.5 top-0 bottom-0 flex items-center">
                  <button
                    type="button"
                    onClick={() => { setOpTab(i); setSel({ kind: 'setup', i }); setSetupOpen(i); if (wide) setRightOpen(true); else setRightDrawer(true); }}
                    aria-label={t('camAi.ws.opSettings', { op: (i + 1) * 10 })}
                    title={t('camAi.ws.opSettings', { op: (i + 1) * 10 })}
                    className="no-glass grid place-items-center w-7 h-7 rounded-[6px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[rgba(var(--ov),0.1)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <Settings2 size={14} stroke={1.8} aria-hidden />
                  </button>
                </span>
                </div>
              ))}
            </div>
            {!narrow && (
              <button type="button" className={collapseBtn} onClick={toggleTools} aria-label={t('camAi.ws.hideTools')} title={`${t('camAi.ws.hideTools')}  [`}>
                <SidebarLeftCollapse size={18} stroke={1.6} />
              </button>
            )}
          </div>
          {result.setups[opNow] && (
            <p className="px-4 pb-2 flex justify-between gap-2 text-xs text-[var(--text-secondary)] tabular-nums">
              <span className="min-w-0">{stepName(opNow).turn} · {parallelsText(opNow)}</span>
              <span>{fmtTime(result.setups[opNow].ops.reduce((a, o) => a + o.seconds, 0))}</span>
            </p>
          )}
          <ul aria-label={t('camAi.ws.tools')} className="px-2 space-y-0.5">
            {(() => {
              // One row per tool, in the order asked (shown at once, before it is checked), else as made.
              const ops = result.setups[opNow]?.ops ?? [];
              const byCode = new Map(ops.map((o) => [o.code, o] as const));
              return toolOrder(result.setups[opNow]?.side ?? '', ops, opOrder).map((c) => byCode.get(c)!);
            })().map((o, idx, all) => {
              const on = sel.kind === 'tool' && sel.i === opNow && sel.code === o.code;
              const secs = result.setups[opNow].ops.filter((x) => x.code === o.code).reduce((a, x) => a + x.seconds, 0);
              const label = `T${o.tool}`;
              return (
                <li
                  key={o.code}
                  // Dragged to another place in the clamping (you); the line shows where it lands.
                  draggable={!busy}
                  onDragStart={(e) => { setDragCode(o.code); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', o.code); }}
                  onDragOver={(e) => {
                    if (!dragCode) return;
                    e.preventDefault();
                    const r = e.currentTarget.getBoundingClientRect();
                    setDropAt(e.clientY < r.top + r.height / 2 ? idx : idx + 1);
                  }}
                  onDrop={(e) => { e.preventDefault(); if (dragCode && dropAt !== null) moveTool(opNow, dragCode, dropAt); setDragCode(null); setDropAt(null); }}
                  onDragEnd={() => { setDragCode(null); setDropAt(null); }}
                  className={`rounded-[8px] ${dragCode === o.code ? 'opacity-50' : ''} ${dragCode && dropAt === idx ? 'shadow-[inset_0_2px_0_var(--accent-primary)]' : dragCode && dropAt === all.length && idx === all.length - 1 ? 'shadow-[inset_0_-2px_0_var(--accent-primary)]' : ''}`}
                >
                  <button
                    type="button"
                    // A tool CAM AI took from the database, not in the chosen machine (you): yellow.
                    className={`${row(on)} ${o.inMachine ? '' : 'ring-1 ring-inset ring-[#facc15]/70 bg-[#facc15]/[0.08]'} ${busy ? '' : 'cursor-grab active:cursor-grabbing'}`}
                    aria-current={on || undefined}
                    onClick={() => { setSwapAsk(null); setSel({ kind: 'tool', i: opNow, code: o.code }); if (!wide) setRightDrawer(true); }}
                    // Right click: straight to changing the tool (you, Beta 2).
                    onContextMenu={(e) => { e.preventDefault(); setSwapAsk(o.code); setSel({ kind: 'tool', i: opNow, code: o.code }); }}
                    // Alt + arrows: the same as dragging it one place.
                    onKeyDown={(e) => {
                      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
                      e.preventDefault();
                      moveTool(opNow, o.code, e.key === 'ArrowUp' ? idx - 1 : idx + 2);
                    }}
                    title={`${t('camAi.rightClickSwap')} · ${t('camAi.ws.dragHint')}`}
                  >
                    {/* The tool's colour as the tint; its number in that colour on the dark theme, in the text colour on the light one (readable). */}
                    <span title={label} className="w-[52px] h-[22px] shrink-0 grid place-items-center rounded-[6px] font-mono text-xs overflow-hidden whitespace-nowrap text-[var(--text-primary)] dark:text-[var(--tool)]" style={{ background: `${toolColor(o.tool)}26`, '--tool': toolColor(o.tool) } as CSSProperties}>
                      {label.length > 5 ? `${label.slice(0, 4)}…` : label}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-[13px] font-medium text-[var(--text-primary)] truncate">{t(`camAi.tools.${o.type}`, { defaultValue: o.type })}</span>
                      {/* The size gives way first: "not in machine" stays whole (amber text on the light theme). */}
                      <span className="flex text-xs text-[var(--text-secondary)] tabular-nums">
                        <span className="truncate">Ø{fmt(o.diameter, 2)} · L{fmt(o.length, 0)}</span>
                        {!o.inMachine && <span className="shrink-0 whitespace-pre text-[#854d0e] dark:text-[#facc15]" title={t(o.code.endsWith('_HAND') ? 'camAi.notInMachineHand' : 'camAi.notInMachineLong')}> · {t('camAi.notInMachine')}</span>}
                      </span>
                    </span>
                    {(changed.includes(o.code) || o.unsafe) && <AlertTriangle size={14} className="shrink-0 text-[var(--orange-text)]" aria-label={t('camAi.changedBadge')} />}
                    <span className="text-xs text-[var(--text-secondary)] tabular-nums">{fmtTime(secs)}</span>
                  </button>
                  {/* The picked tool's own actions: play it alone, its settings, delete it (asked first). */}
                  {on && (
                    <div role="group" aria-label={label} className="flex gap-1 px-1 pt-1 pb-1.5">
                      <button type="button" className={rowAct} onClick={() => setSimFocus({ setup: opNow, tool: o.tool, key: Date.now(), play: true })} disabled={busy}>
                        <PlayerPlay size={14} stroke={1.8} aria-hidden />
                        {t('camAi.ws.rowPlay')}
                      </button>
                      <button type="button" className={rowAct} onClick={() => (wide ? setRightOpen(true) : setRightDrawer(true))} aria-label={t('camAi.ws.rowSettings')} title={t('camAi.ws.rowSettings')}>
                        <Settings2 size={14} stroke={1.8} aria-hidden />
                      </button>
                      <button type="button" className={rowAct} onClick={() => moveTool(opNow, o.code, idx - 1)} disabled={busy || idx === 0} aria-label={t('camAi.ws.rowUp', { tool: o.tool })} title={t('camAi.ws.rowUp', { tool: o.tool })}>
                        <ArrowUp size={14} stroke={1.8} aria-hidden />
                      </button>
                      <button type="button" className={rowAct} onClick={() => moveTool(opNow, o.code, idx + 2)} disabled={busy || idx === all.length - 1} aria-label={t('camAi.ws.rowDown', { tool: o.tool })} title={t('camAi.ws.rowDown', { tool: o.tool })}>
                        <ArrowDown size={14} stroke={1.8} aria-hidden />
                      </button>
                      <button type="button" className={`${rowAct} hover:!text-red-400`} onClick={() => setDropAsk({ i: opNow, code: o.code, tool: o.tool })} disabled={busy} aria-label={t('camAi.ws.rowDelete')} title={t('camAi.ws.rowDelete')}>
                        <Trash size={14} stroke={1.8} aria-hidden />
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
            {/* Deleted tools (you): crossed out, never gone from the list; Restore brings them back. */}
            {goneTools(opNow).map(({ g, keys }) => {
              const label = `T${g.tool}`;
              const still = keys.some(isGone);
              return (
                <li key={`gone-${g.code}`} className="flex items-center gap-2 px-2 min-h-11 rounded-[8px] text-[var(--text-secondary)]">
                  <span className="w-[52px] h-[22px] shrink-0 grid place-items-center rounded-[6px] font-mono text-xs line-through opacity-60 text-[var(--text-primary)] dark:text-[var(--tool)]" style={{ background: `${toolColor(g.tool)}14`, '--tool': toolColor(g.tool) } as CSSProperties}>
                    {label}
                  </span>
                  <span className={`flex-1 min-w-0 ${still ? 'line-through opacity-70' : ''}`}>
                    <span className="block text-[13px] truncate">{t(`camAi.tools.${g.type}`, { defaultValue: g.type })}</span>
                    <span className="block text-xs tabular-nums">Ø{fmt(g.diameter, 2)} · L{fmt(g.length, 0)}{still ? '' : ` · ${t('camAi.ws.backNext')}`}</span>
                  </span>
                  {still && (
                    <button type="button" className={rowAct} onClick={() => restore(keys, label)} disabled={busy} aria-label={t('camAi.ws.rowRestore', { tool: label })} title={t('camAi.ws.rowRestore', { tool: label })}>
                      <RotateCcw size={14} stroke={1.8} aria-hidden />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="flex-1" />
          <ul className="px-2 py-2 border-t border-[var(--border-subtle)] space-y-0.5">
            <li>
              <button type="button" className={row(sel.kind === 'part')} onClick={() => setSel({ kind: 'part' })}>
                <Cube size={16} stroke={1.6} className="shrink-0 text-[var(--text-secondary)]" aria-hidden />
                <span className="flex-1 min-w-0 truncate text-[13px] text-[var(--text-primary)]">{prep?.title ?? name}</span>
              </button>
            </li>
            <li>
              <button type="button" className={row(sel.kind === 'program')} onClick={() => setSel({ kind: 'program' })}>
                <FileCode2 size={16} stroke={1.6} className="shrink-0 text-[var(--text-secondary)]" aria-hidden />
                <span className="flex-1 min-w-0 truncate text-[13px] text-[var(--text-primary)]">{fileName}</span>
              </button>
            </li>
          </ul>
        </>
      ) : prep ? (
        <>
          <div className="flex items-center gap-2 p-2">
            <span className="flex-1 px-2 text-[13px] font-semibold text-[var(--text-primary)]">{t('camAi.ws.prepare')}</span>
            {!narrow && (
              <button type="button" className={collapseBtn} onClick={toggleTools} aria-label={t('camAi.ws.hideTools')} title={`${t('camAi.ws.hideTools')}  [`}>
                <SidebarLeftCollapse size={18} stroke={1.6} />
              </button>
            )}
          </div>
          <ul className="px-2 space-y-0.5">
            <li>
              <button type="button" className={row(sel.kind === 'part')} aria-current={sel.kind === 'part' || undefined} onClick={() => setSel({ kind: 'part' })}>
                <Cube size={16} stroke={1.6} className="shrink-0 text-[var(--text-secondary)]" aria-hidden />
                <span className="flex-1 min-w-0 truncate text-[13px] text-[var(--text-primary)]">{prep.title ?? name}</span>
                {!partType && <AlertTriangle size={14} className="text-[var(--orange-text)]" aria-label={t('camAi.ws.needs')} />}
              </button>
            </li>
            <li>
              <button type="button" className={row(sel.kind === 'stock')} aria-current={sel.kind === 'stock' || undefined} onClick={() => setSel({ kind: 'stock' })}>
                <Box size={16} stroke={1.6} className="shrink-0 text-[#f5a524]" aria-hidden />
                <span className="flex-1 text-[13px] text-[var(--text-primary)]">{t('camAi.ws.stock')}</span>
                {chosen && excess && <span className="tabular-nums text-xs text-[var(--text-secondary)]">{[0, 1, 2].map((k) => fmt(chosen.size[k] + excess[k], 1)).join('×')}</span>}
              </button>
            </li>
            <li className="px-2 pt-3 pb-1 text-xs text-[var(--text-secondary)]">{t('camAi.ws.clampings')}</li>
            {setupNodes.map(({ i, side }) => {
              const done = i === 0 ? locked1 : i === 1 ? locked2 : true;
              return (
                <li key={i}>
                  <button type="button" className={row(sel.kind === 'setup' && sel.i === i)} aria-current={(sel.kind === 'setup' && sel.i === i) || undefined} onClick={() => setSel({ kind: 'setup', i })}>
                    {done ? <CheckCircle2 size={16} stroke={1.6} className="shrink-0 text-[var(--green-text,#1fb257)]" aria-hidden /> : <span className="w-4 h-4 shrink-0 grid place-items-center" aria-hidden><span className="w-2 h-2 rounded-full bg-[var(--accent-primary)]" /></span>}
                    <span className="flex-1 text-[13px] text-[var(--text-primary)]">{t('camAi.setupStep', { n: i + 1, op: (i + 1) * 10 })}</span>
                    <span className="font-mono text-xs text-[var(--text-secondary)]">{side}</span>
                    <span className="sr-only">{t(done ? 'camAi.stepState.done' : 'camAi.stepState.now')}</span>
                  </button>
                </li>
              );
            })}
            {locked1 && locked2 && <li className="px-2 py-1 text-xs text-[var(--text-secondary)]">{t('camAi.restByAi')}</li>}
            {!locked1 && (
              <li className="flex items-center gap-2.5 px-2 h-11 text-[13px] text-[var(--text-secondary)]">
                <Lock size={16} stroke={1.6} aria-hidden /> {t('camAi.setupStep', { n: 2, op: 20 })}
                <span className="sr-only">{t('camAi.stepState.locked')}</span>
              </li>
            )}
          </ul>
          <div className="flex-1" />
          <p className="px-4 py-3 border-t border-[var(--border-subtle)] text-xs text-[var(--text-secondary)]" role="status">{next ? t(`camAi.ws.next.${next}`) : t('camAi.ws.ready')}</p>
        </>
      ) : (
        <div className="p-4 space-y-3">
          <p className="text-[13px] text-[var(--text-secondary)]">{t('camAi.ws.empty')}</p>
          <button type="button" className="btn-primary text-[13px] h-9 px-4 inline-flex items-center gap-2" onClick={() => setDialog(true)} disabled={busy}>
            <FilePlus2 size={16} /> {t('camAi.ws.new')}
          </button>
          <button type="button" className="btn-secondary text-[13px] h-9 px-4 inline-flex items-center gap-2" onClick={() => programRef.current?.click()} disabled={busy}>
            <FileCode2 size={16} /> {t('camAi.open.menu')}
          </button>
          {openError && <p className="text-xs text-[var(--orange-text)]" role="alert">{t('camAi.open.read')}</p>}
        </div>
      )}
    </>
  );

  const inspectorBody = (
    <>
      {result && sel.kind === 'tool' ? null : (
        <div className="h-12 shrink-0 flex items-center gap-2 pl-4 pr-2 border-b border-[var(--border-subtle)]">
          <h2 id="cam-props" className="flex-1 min-w-0 truncate text-[15px] font-semibold text-[var(--text-primary)]">
            {sel.kind === 'part' ? t('camAi.ws.partProps') : sel.kind === 'stock' ? t('camAi.ws.stock') : sel.kind === 'program' ? fileName : sel.kind === 'setup' ? t('camAi.setupStep', { n: sel.i + 1, op: (sel.i + 1) * 10 }) : t('camAi.ws.toolProps')}
          </h2>
          <button type="button" className={collapseBtn} onClick={toggleInspector} aria-label={t(wide ? 'camAi.ws.hideInspector' : 'camAi.ws.close')} title={wide ? `${t('camAi.ws.hideInspector')}  ]` : t('camAi.ws.close')}>
            {wide ? <SidebarRightCollapse size={18} stroke={1.6} /> : <X size={18} stroke={1.6} />}
          </button>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto relative">
            {result && sel.kind === 'tool' && (() => {
              const s = result.setups[sel.i];
              const ops = s?.ops.filter((o) => o.code === sel.code) ?? [];
              if (!ops.length || !machine || !templatesFor) return null;
              return (
                <>
                  <ToolCard
                    aside={
                      <button type="button" className={collapseBtn} onClick={toggleInspector} aria-label={t(wide ? 'camAi.ws.hideInspector' : 'camAi.ws.close')} title={wide ? `${t('camAi.ws.hideInspector')}  ]` : t('camAi.ws.close')}>
                        {wide ? <SidebarRightCollapse size={18} stroke={1.6} /> : <X size={18} stroke={1.6} />}
                      </button>
                    }
                    key={`${sel.code}|${swapAsk === sel.code}`}
                    ask={swapAsk === sel.code}
                    opEdits={opEdits}
                    checking={checking}
                    onOpEdit={(key, e) => {
                      const was = opEdits;
                      const next = { ...opEdits };
                      if (e) next[key] = e;
                      else delete next[key];
                      applyEdits(next, key);
                      addChange({ now: true, label: t('camAi.bar.edited'), undo: () => applyEdits(was, key) });
                    }}
                    shop={catalog(templatesFor, tools, { exclude: swap.exclude, toolDb: toolDb.db })}
                    hits={result.collisions}
                    onUse={(tool) => {
                      const was = opEdits;
                      const next = { ...opEdits };
                      for (const o of ops) {
                        const e: OpEdit = { ...next[o.key] };
                        delete e.tool;
                        if (tool) e.tool = tool;
                        if (Object.keys(e).length) next[o.key] = e;
                        else delete next[o.key];
                      }
                      applyEdits(next, ops[0].key);
                      // By the tool they were made with (a second change, or Back, replaces the first).
                      const sk = `${result.setups[sel.i].side}|${madeCode(ops[0].key)}`;
                      const swapsWas = toolSwaps;
                      setToolSwaps((w) => {
                        const n = { ...w };
                        if (tool) n[sk] = tool;
                        else delete n[sk];
                        return n;
                      });
                      addChange({
                        now: true,
                        label: tool ? t('camAi.bar.swapped', { tool: ops[0].tool }) : t('camAi.changes.back', { tool: ops[0].tool }),
                        undo: () => {
                          applyEdits(was, ops[0].key);
                          setToolSwaps(swapsWas);
                        },
                        // Made again: the plan as before, this tool on the old one's paths again (toolSwaps), never planned around.
                      });
                    }}
                    ops={ops}
                    draft={draft[sel.code] ?? {}}
                    changed={changed.includes(sel.code)}
                    busy={busy}
                    onEdit={(v) => {
                      const code = sel.code;
                      setDraft((d) => ({ ...d, [code]: { ...d[code], ...v } }));
                      // One line a tool: its entry stays listed (hidden while the values are as made) however often the values pass back.
                      if (!changes.some((c) => c.cuts === code))
                        addChange({
                          label: t('camAi.changes.cuts', { tool: ops[0].tool }),
                          cuts: code,
                          undo: () =>
                            setDraft((d) => {
                              const n = { ...d };
                              if (cuts[code]) n[code] = cuts[code];
                              else delete n[code];
                              return n;
                            }),
                        });
                    }}
                    removing={skipDraft}
                    onRemove={toggleOp}
                    gone={Object.entries(gone)
                      .filter(([k, g]) => g.side === result.setups[sel.i]?.side && g.code === sel.code && !result.setups[sel.i].ops.some((o) => o.key === k) && (isGone(k) || skip.includes(k)))
                      .map(([k, g]) => ({ key: k, purpose: g.purpose, still: isGone(k) }))}
                    onRestore={(k) => restore([k], `T${gone[k]?.tool ?? ''}`)}
                    focus={sel.op ?? null}
                    onFocus={(op) => setSel({ kind: 'tool', i: sel.i, code: sel.code, op: op ?? undefined })}
                    options={alternatives(templatesFor, tools, sel.code, swap.exclude, toolDb.db)}
                    toolName={toolName}
                    onSwap={(_code, standIn) => {
                      // Listed like every change (the owner: one Make again for all); made with the others. Kept too: where
                      // the plan made again still uses the old tool in this clamping, the new one takes its paths (you).
                      const st = catalog(templatesFor, tools, { toolDb: toolDb.db }).find((x) => x.code === standIn);
                      const made = madeCode(ops[0].key);
                      const sk = `${result.setups[sel.i].side}|${made}`;
                      const swapsWas = toolSwaps;
                      if (st) setToolSwaps((w) => ({ ...w, [sk]: { d: st.diameter, l: st.length, code: st.code } }));
                      addChange({ label: t('camAi.bar.swapped', { tool: ops[0].tool }), undo: () => setToolSwaps(swapsWas), swap: { exclude: made, prefer: standIn } });
                    }}
                  />
                  <p className="px-4 pb-4 text-xs text-[var(--text-secondary)]">{t('camAi.everywhere')}</p>
                </>
              );
            })()}
        <div className="p-4 space-y-3 text-[13px]">
            {!prep && <p className="text-[var(--text-secondary)]">{t('camAi.ws.empty')}</p>}

            {prep && sel.kind === 'part' && (
              <>
                {prep.title ? (
                  <dl className="space-y-1">
                    <div><dt className="inline text-[var(--text-secondary)]">{t('camAi.part.title')}: </dt><dd className="inline font-medium text-[var(--text-primary)]">{prep.title}</dd></div>
                    {prep.sap && <div><dt className="inline text-[var(--text-secondary)]">{t('camAi.part.sap')}: </dt><dd className="inline font-mono text-[var(--text-primary)]">{prep.sap}</dd></div>}
                  </dl>
                ) : (
                  // The type chosen: only the fact stays, neutral (a step no longer missing).
                  partType ? <p className="text-[var(--text-secondary)]">{t('camAi.part.noName')}</p> : <p className="text-[var(--orange-text)]">{t('camAi.part.noTitle')}</p>
                )}
                {partFields()}
                {shapesList()}
                {whiteFields()}
                {finishFields()}
              </>
            )}

            {result && handEdited && (
              <section className="space-y-1.5 rounded-[var(--radius-md)] border border-[var(--accent-primary)]/40 p-2.5" aria-live="polite">
                <p className="text-[var(--text-primary)]">{t('camAi.opEdit.changed', { count: Object.keys(opEdits).length, pct: fmt(result.match * 100, 1), mm3: fmt(result.gouge, 0) })}</p>
                {safeButHold(result) && (!alike(result) || result.misplaced > 0) && (
                  <label className="flex items-center gap-2 min-h-9 text-[var(--text-primary)]">
                    <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
                    {t('camAi.opEdit.accept')}
                  </label>
                )}
              </section>
            )}
            {editsDropped && <p className="text-[var(--text-secondary)]" role="status">{t('camAi.opEdit.dropped')}</p>}
            {editRefused && <p className="text-[var(--orange-text)]" role="alert">{t('camAi.opEdit.refused')}</p>}
            {prep && chosen && sel.kind === 'stock' && (
              <>
                <button type="button" role="switch" aria-checked={autoStock} onClick={() => choose(() => setAutoStock(!autoStock))} disabled={busy} className="no-glass flex items-center gap-2 text-xs text-[var(--text-primary)] min-h-11">
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
                        <button key={m} type="button" role="radio" aria-checked={stockMode === m} onClick={() => choose(() => setStockMode(m))} className={`no-glass text-xs px-3 min-h-9 rounded-[calc(var(--radius-md)-2px)] ${stockMode === m ? 'bg-[var(--accent-primary)]/15 text-[var(--text-primary)] font-medium' : 'text-[var(--text-secondary)]'}`}>
                          {t(`camAi.stock.${m}`)}
                        </button>
                      ))}
                    </div>
                    {stockMode === 'total' ? (
                      (['X', 'Y', 'Z'] as const).map((axis, k) => (
                        <label key={axis} className="grid grid-cols-[1fr_7rem] items-center gap-2">
                          <span className="text-[var(--text-secondary)]">{t('camAi.stock.totalAxis', { axis })}</span>
                          <input className="aurora-input w-full min-w-0 text-xs px-2 tabular-nums" type="number" min={0} step={0.5} inputMode="decimal" value={totals[k]} onChange={(e) => choose(() => setTotals(totals.map((v, i) => (i === k ? e.target.value : v))))} />
                        </label>
                      ))
                    ) : (
                      <>
                        <CamStockBox size={chosen.size} values={sides.map((v, i) => (i === whiteAt ? '0' : v))} locked={whiteAt} onChange={(i, v) => choose(() => setSides(sides.map((x, k) => (k === i ? v : x))))} />
                        {whiteAt >= 0 && <p className="text-[var(--text-secondary)]">{t('camAi.stock.whiteNone', { side: STOCK_SIDES[whiteAt] })}</p>}
                      </>
                    )}
                    {!excessOk && <p className="text-[var(--orange-text)]" role="alert">{t(sidesOk ? 'camAi.stock.tooSmall' : 'camAi.stock.sideRange')}</p>}
                  </fieldset>
                )}
                {shown && under1 === 'tooThin' && <p className="flex gap-2 text-[var(--orange-text)]" role="alert"><AlertTriangle size={15} className="shrink-0" aria-hidden />{whiteAt === 4 ? t('camAi.stock.whiteDown') : t('camAi.stock.tooThin', { mm: fmt(shown[4], 1) })}</p>}
                {shown && topThin && under1 !== 'tooThin' && <p className="flex gap-2 text-[var(--orange-text)]" role="alert"><AlertTriangle size={15} className="shrink-0" aria-hidden />{t('camAi.stock.topThin', { mm: fmt(shown[5], 1) })}</p>}
                {shown && under1 === 'lowGrip' && <p className="flex gap-2 text-[#facc15]" role="status"><AlertTriangle size={15} className="shrink-0" aria-hidden />{t('camAi.stock.lowGrip', { mm: fmt(shown[4], 1) })}</p>}
                {raw && excess && (
                  <dl className="grid grid-cols-3 gap-2">
                    {(['X', 'Y', 'Z'] as const).map((axis, k) => (
                      <div key={axis} className="rounded-[var(--radius-md)] border border-[#f5a524]/40 px-2 py-1.5">
                        <dt className="text-xs text-[var(--text-secondary)]">{axis}</dt>
                        <dd className="font-semibold tabular-nums text-[var(--text-primary)]">{fmt(chosen.size[k] + excess[k], 1)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {excess && !margins && <p className="text-[var(--text-secondary)]">{t('camAi.stock.added', { x: fmt(excess[0], 1), y: fmt(excess[1], 1), z: fmt(excess[2], 1) })}</p>}
                {whiteFields()}
                {finishFields()}
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
                              <span className="block text-center font-mono text-xs text-[var(--text-secondary)]">{l.side}{l.spin ? ' ⟲' : ''}</span>
                            </label>
                          ))}
                        </fieldset>
                      </details>
                    )}
                  </>
                )}
                {/* Its settings (you): how the part lies, turned by quarter turns about X and Y, with your model's green figure. */}
                {result?.setups[sel.i] && setupOpen === sel.i && !busy && (
                  <TurnPanel
                    key={sel.i}
                    n={sel.i + 1}
                    made={result.setups[sel.i].R as Mat3}
                    turned={turned[sel.i]}
                    tris={prep.tris}
                    used={result.setups.slice(0, sel.i).map((x) => x.side)}
                    onPress={(p) => turnBy(sel.i, p)}
                    onOwn={() => turnOwn(sel.i)}
                  />
                )}
                {sel.i === 0 && (clampMode || (!!result && !busy)) && cale1 !== null && <ClampPanel key={setupOpen === 0 ? 'open' : 'shut'} cale={cale1} own={clamp1 !== null ? own1 : null} mine={clamp1 !== null} grip={JAW - cale1} intoPart={cale1 > 0 && chosen ? JAW - cale1 - (-chosen.size[2] - lo1) : 0} seam={!!chosen && -chosen.size[2] - lo1 > 0.5 && cale1 > 0 && !clearOf(lo1, chosen.size[2], JAW - cale1)} jaw={jaw} onAct={clampAct} pending={result && clamp1 !== null && clamp1 !== result.setups[0]?.cale ? clamp1 : undefined} refused={refused1} stop={stop1} stopPending={!!result && stop1 !== Number(result.setups[0]?.notes.join(' ').match(/(\d+) MM ZWISCHENLAGE IN X-/)?.[1] ?? 0)} onStop={(v) => { holdChanged(v ? t('camAi.changes.stop', { n: 1, mm: v }) : t('camAi.changes.stopNone', { n: 1 })); setStop1(v); resetLater(); }} onOwn={() => { holdChanged(t('camAi.changes.own', { n: 1 })); setClamp1(null); resetLater(); }} cales={cales1} onCale={(v) => { holdChanged(v ? t('camAi.changes.parallels', { n: 1, mm: fmt(v, 0) }) : t('camAi.changes.table', { n: 1 })); setClamp1(v); resetLater(); }} y={laterX[0]?.y} onY={(v) => { holdChanged(v === undefined ? t('camAi.changes.yAuto', { n: 1 }) : v ? t('camAi.changes.y', { n: 1, mm: v }) : t('camAi.changes.yNone', { n: 1 })); setLaterX((x) => ({ ...x, 0: { ...x[0], y: v } })); }} yp={laterX[0]?.yp} onYp={(v) => { holdChanged(t('camAi.hold.changed', { n: 1 })); setLaterX((x) => ({ ...x, 0: { ...x[0], yp: v } })); resetLater(); }} made={!!result && setupOpen !== 0} onOpenChange={(o) => setSetupOpen(o ? 0 : null)} />}
                {sel.i > 0 && result?.setups[sel.i] && !busy && (
                  <LaterClampPanel
                    key={`${sel.i}-${setupOpen === sel.i}`}
                    openAt={setupOpen === sel.i}
                    n={sel.i + 1}
                    made={result.setups[sel.i]}
                    used={result.setups.slice(0, sel.i).map((x) => x.side)}
                    asked={later[sel.i]}
                    spacers={laterX[sel.i] ?? {}}
                    madeTurn={madeTurns[sel.i] ?? {}}
                    emptySide={!!laterX[sel.i]?.side && result.notes.some((x) => x.key === 'sideEmpty' && x.side === laterX[sel.i]?.side)}
                    refusals={result.notes.filter((x) => x.setup === sel.i + 1 && (x.key === 'clampRefused' || x.key === 'jawRefused' || x.key === 'stepRefused' || x.key === 'stepHold' || x.key === 'stopRefused' || x.key === 'spacerRefused' || x.key === 'clampNest'))}
                    onAsk={(v, x) => {
                      const i = sel.i;
                      holdChanged(holdLabel(i + 1, later[i], laterX[i] ?? {}, v, x));
                      // The clampings after this one hold what it leaves: their choices go.
                      const keep = <T,>(l: Record<number, T>) => Object.fromEntries(Object.entries(l).filter(([k]) => Number(k) < i)) as Record<number, T>;
                      setLater((l) => ({ ...keep(l), ...(v !== null ? { [i]: v } : {}) }));
                      setLaterX((l) => ({ ...keep(l), ...(Object.keys(x).length ? { [i]: x } : {}) }));
                    }}
                  />
                )}
                {result?.setups[sel.i] && <SetupPanel setup={result.setups[sel.i]} />}
              </>
            )}

            {result && sel.kind === 'program' && machine && (
              <ProgramPanel
                result={result}
                machineName={machine.name}
                machineId={engineId}
                changed={changed.length + pendingSkips}
                removed={skipDraft.map((k) => ({ key: k, label: skipLabels[k] ?? k }))}
                onRestore={(k) => {
                  setSkipDraft((d) => d.filter((x) => x !== k));
                  setChanges((l) => l.filter((c) => c.removed !== k));
                }}
                shown={ghostOn}
                onShow={setGhostOn}
              />
            )}

            {run.state === 'error' && (
              <p className="badge-danger text-xs py-1.5 px-3" role="alert">
                {run.error === 'failed' ? t('camAi.failed') : run.error === 'thinBlank' ? t('camAi.stock.thinRefused') : run.error === 'toolDb' ? t('camAi.db.loadFailed') : t(`camAi.modelErrors.${run.error}`)}
              </p>
            )}
        </div>
      </div>
    </>
  );

  if (opened)
    return (
      <>
        <CamOpened name={opened.name} code={opened.code} model={model} machine={machine} onSend={(...a) => leave(() => onSend(...a), true)} onExit={() => leave(onExit)} onClose={() => setOpened(null)} />
        {leaveDialog()}
      </>
    );

  return (
    <div className="cam-ws h-full w-full flex flex-col bg-[var(--bg-page)] text-[13px] text-[var(--text-primary)]">
      <input ref={programRef} type="file" accept=".nc,.txt,.tap,.mpf,.ngc,.cnc,.h,.min,.x20,.c96,.000,text/plain" className="hidden" onChange={(e) => { void openProgram(e.target.files?.[0]); e.target.value = ''; }} />
      <input ref={fileRef} type="file" accept=".pdf,.stl,.step,.stp" className="hidden" onChange={(e) => { void pick(e.target.files?.[0]); setDialog(true); e.target.value = ''; }} />

      {/* One bar: back to the app, the file, its stock and checks, its time, Download and Send. */}
      <header className="h-12 shrink-0 flex items-center gap-2 px-2 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)]">
        <button type="button" onClick={() => leave(onExit)} title={t('camAi.ws.backTitle')} aria-label={t('camAi.ws.backTitle')} className="no-glass h-8 flex items-center gap-2 pl-1.5 pr-2.5 rounded-[8px] hover:bg-[rgba(var(--ov),0.08)]">
          <ArrowLeft size={16} stroke={1.8} className="text-[var(--text-secondary)]" aria-hidden />
          <span className="w-6 h-6 rounded-[6px] bg-gradient-to-br from-[var(--blue-500)] to-violet-700 grid place-items-center text-white font-mono font-bold text-xs" aria-hidden>//</span>
          <span className="text-[13px] font-semibold text-[var(--text-primary)] whitespace-nowrap hidden xl:inline">{t('camAi.ws.back')}</span>
        </button>
        <span className="text-[var(--text-secondary)]" aria-hidden>/</span>
        <span className="flex items-center gap-1.5 shrink-0 whitespace-nowrap">
          <Cpu size={16} stroke={1.6} className="shrink-0 text-[var(--accent-primary)]" aria-hidden />
          <span className="text-[13px] font-semibold">CAM AI</span>
          <span className="text-xs text-[var(--orange-text)] hidden lg:inline">{t('camAi.beta')}</span>
        </span>
        {prep && (
          <>
            <span className="text-[var(--text-secondary)]" aria-hidden>/</span>
            <button type="button" onClick={() => setSel({ kind: result ? 'program' : 'part' })} className="no-glass h-8 px-1.5 rounded-[6px] font-mono text-[13px] truncate min-w-0 max-w-[16rem] hover:bg-[rgba(var(--ov),0.08)]">{result ? fileName : name}</button>
          </>
        )}
        {chosen && excess && (
          <button type="button" onClick={() => setSel({ kind: 'stock' })} title={t('camAi.ws.stockTitle')} className="no-glass h-7 shrink-0 whitespace-nowrap hidden lg:inline-flex items-center gap-1.5 px-2 rounded-[6px] border border-[var(--border-subtle)] text-xs text-[var(--text-secondary)] tabular-nums hover:text-[var(--text-primary)]">
            <Box size={14} stroke={1.6} aria-hidden />
            {[0, 1, 2].map((k) => fmt(chosen.size[k] + excess[k], 0)).join('×')}
          </button>
        )}
        <Popover.Root>
          <Popover.Trigger asChild>
            <button type="button" className={`no-glass h-7 shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 px-2.5 rounded-[8px] border text-xs font-medium ${run.state === 'busy' || (result && !issues && pendingMake) ? 'border-[var(--blue-500)]/40 text-[var(--blue-text)]' : !result ? 'border-[var(--border-subtle)] text-[var(--text-secondary)]' : !issues ? 'border-[#4ade80]/40 bg-[#4ade80]/10 text-[var(--green-text,#1fb257)]' : 'border-[#f87171]/45 bg-[#f87171]/12 text-[#f87171]'}`}>
              {run.state === 'busy' ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden /> : !result ? null : issues ? <AlertTriangle size={14} stroke={2} aria-hidden /> : pendingMake ? <RefreshCw size={14} stroke={2} aria-hidden /> : <CheckCircle2 size={14} stroke={2} aria-hidden />}
              {run.state === 'busy' ? t('camAi.ws.checking') : !result ? t('camAi.ws.notMade') : issues ? t('camAi.ws.issues', { count: issues }) : pendingMake ? t('camAi.ws.waiting') : t('camAi.ws.checked', { pct: fmt(result.match * 100, 1) })}
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content align="start" sideOffset={6} className="cam-pop z-[1000] w-[22rem] p-2">
              <p className={`px-2 pt-1 pb-2 text-[13px] font-semibold ${!result ? 'text-[var(--text-primary)]' : !issues && pendingMake ? 'text-[var(--blue-text)]' : ok ? 'text-[var(--green-text,#1fb257)]' : 'text-[var(--orange-text)]'}`} role="status">
                {verdict ? (!issues && pendingMake ? t('camAi.makeFirst') : verdict.text) : next ? t(`camAi.ws.next.${next}`) : t('camAi.ws.ready')}
              </p>
              {checks.length > 0 && (
                <ul aria-label={t('camAi.ws.checksTitle')}>
                  {checks.map((c) => (
                    <li key={c.label} className="flex items-center gap-2 h-8 px-2 border-t border-[var(--border-subtle)] text-[13px]">
                      <span className={`w-2 h-2 rounded-full ${c.bad ? 'bg-[#f87171]' : 'bg-[#4ade80]'}`} aria-hidden />
                      <span className="flex-1 text-[var(--text-primary)]">{c.label}</span>
                      <span className="text-xs text-[var(--text-secondary)] tabular-nums">{c.value}</span>
                    </li>
                  ))}
                  <li className="flex items-center gap-2 h-8 px-2 border-t border-[var(--border-subtle)] text-[13px]">
                    <span className="w-2 h-2 rounded-full bg-[var(--text-tertiary)]" aria-hidden />
                    <span className="flex-1 text-[var(--text-primary)]">{t('camAi.ws.check.program')}</span>
                    <span className="text-xs text-[var(--text-secondary)] tabular-nums">{machine?.name} · {templatesFor ?? material}</span>
                  </li>
                </ul>
              )}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        <span className="flex-1" />
        {result && (
          <span className="hidden xl:inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 px-2 text-xs text-[var(--text-secondary)] tabular-nums" title={t('camAi.ws.timeChip', { min: fmt(result.minutes, 0), n: result.toolChanges })}>
            <Clock size={15} stroke={1.6} aria-hidden />
            {t('camAi.ws.timeChip', { min: fmt(result.minutes, 0), n: result.toolChanges })}
          </span>
        )}
        {!wide && (
          <button type="button" className={barBtn} onClick={toggleInspector} aria-expanded={inspectorOpen}>
            <SidebarRightExpand size={16} stroke={1.6} aria-hidden /> {t('camAi.ws.inspector')}
          </button>
        )}
        <button type="button" className={barBtn} onClick={download} disabled={!ok || busy || checking || waiting || handTool || badNumber !== undefined} title={handTool ? t('camAi.opEdit.handTool') : badNumber !== undefined ? t('camAi.opEdit.badNumber', { t: badNumber }) : waiting ? t('camAi.makeFirst') : ok ? undefined : t('camAi.locked')}>
          <Download size={16} stroke={1.6} aria-hidden /> {t('camAi.download')}
        </button>
        {result ? (
          <button type="button" className="btn-primary h-8 px-3.5 text-[13px] shrink-0 whitespace-nowrap inline-flex items-center gap-2" onClick={() => result && ok && !waiting && machine && leave(() => onSend(result.code, fileName, machine.id), true)} disabled={!ok || busy || checking || waiting} title={waiting ? t('camAi.makeFirst') : ok ? undefined : t('camAi.locked')}>
            <Send size={16} stroke={1.8} aria-hidden /> {t('camAi.send')}
          </button>
        ) : run.state === 'busy' ? (
          <button type="button" className={barBtn} onClick={stop}>
            <Square size={15} aria-hidden /> {t('camAi.stop')}
          </button>
        ) : (
          <button type="button" className="btn-primary h-8 px-3.5 text-[13px] shrink-0 whitespace-nowrap inline-flex items-center gap-2" onClick={makeAgain} disabled={!ready || busy}>
            <Play size={16} stroke={1.8} aria-hidden /> {t('camAi.generate')}
          </button>
        )}
        <Popover.Root>
          <Popover.Trigger asChild>
            <button type="button" className="no-glass w-8 h-8 grid place-items-center rounded-[8px] border border-[var(--border-subtle)] text-[var(--text-primary)] hover:bg-[rgba(var(--ov),0.08)]" aria-label={t('camAi.ws.more')} title={t('camAi.ws.more')}>
              <Dots size={18} stroke={1.8} aria-hidden />
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content align="end" sideOffset={6} className="cam-pop z-[1000] w-72 p-1">
              <Popover.Close asChild>
                <button type="button" className={menuItem} onClick={() => setDialog(true)} disabled={busy}>
                  <FilePlus2 size={16} stroke={1.6} aria-hidden /> {t('camAi.ws.new')}
                </button>
              </Popover.Close>
              <Popover.Close asChild>
                <button type="button" className={menuItem} onClick={() => programRef.current?.click()} disabled={busy}>
                  <FileCode2 size={16} stroke={1.6} aria-hidden /> {t('camAi.open.menu')}
                </button>
              </Popover.Close>
              {result && (
                <>
                  <Popover.Close asChild>
                    <button type="button" className={menuItem} onClick={makeAgain} disabled={!ready || busy || checking}>
                      <RefreshCw size={16} stroke={1.6} aria-hidden /> {t('camAi.ws.againKey')}
                    </button>
                  </Popover.Close>
                  {run.state === 'busy' && (
                    <Popover.Close asChild>
                      <button type="button" className={menuItem} onClick={stop}>
                        <Square size={15} aria-hidden /> {t('camAi.stop')}
                      </button>
                    </Popover.Close>
                  )}
                  <Popover.Close asChild>
                    <button type="button" className={menuItem} onClick={() => setSimFocus({ setup: 0, play: true, key: Date.now() })}>
                      <PlayerPlay size={16} stroke={1.6} aria-hidden /> {t('camAi.ws.simulateStart')}
                    </button>
                  </Popover.Close>
                  <Popover.Close asChild>
                    <button type="button" role="menuitemcheckbox" aria-checked={nx} className={menuItem} onClick={() => setNx(!nx)}>
                      <Route size={16} stroke={1.6} aria-hidden /> <span className="flex-1">{t('camAi.ws.nxView')}</span> {nx && <Check size={15} aria-hidden />}
                    </button>
                  </Popover.Close>
                </>
              )}
              <div className="mt-1 pt-2 px-2.5 pb-2 border-t border-[var(--border-subtle)] space-y-1.5">
                <span className="flex items-center gap-2 text-[13px] font-medium"><Settings2 size={16} stroke={1.6} aria-hidden /> {t('camAi.settings')}</span>
                <label className="block space-y-1">
                  <span className="block text-xs text-[var(--text-secondary)]">{t('camAi.sideStock')}</span>
                  <input
                    className="aurora-input w-full h-8 py-0 text-[13px]"
                    type="number"
                    min={0}
                    max={0.5}
                    step={0.01}
                    inputMode="decimal"
                    value={sideText ?? sideStock}
                    aria-invalid={!sideTextOk || undefined}
                    onChange={(e) => {
                      const v = e.target.value;
                      setSideText(v);
                      if (v.trim() !== '' && Number(v) >= 0 && Number(v) <= 0.5) saveSideStock(Number(v));
                    }}
                    onBlur={() => setSideText(null)}
                  />
                </label>
                {!sideTextOk && <p className="text-xs text-[var(--orange-text)]" role="alert">{t('camAi.sideStockBad', { mm: fmt(sideStock, 2) })}</p>}
                <p className="text-xs text-[var(--text-secondary)]">{t('camAi.sideStockHint')}</p>
                <Popover.Close asChild>
                  <button type="button" className={`${menuItem} -mx-2.5 w-[calc(100%+1.25rem)]`} onClick={() => setDbOpen(true)}>
                    <Database size={16} stroke={1.6} aria-hidden /> {t('camAi.db.menu')}
                  </button>
                </Popover.Close>
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </header>

      <div className="flex-1 min-h-0 flex relative">
        {/* The tools of one clamping (or, before a program, what is being prepared). */}
        {!narrow && (leftOpen ? (
          <nav aria-label={t('camAi.ws.tools')} className="w-[260px] shrink-0 flex flex-col overflow-y-auto border-r border-[var(--border-subtle)] bg-[var(--bg-panel)]">{toolList}</nav>
        ) : (
          <div className="w-10 shrink-0 flex flex-col items-center pt-2 border-r border-[var(--border-subtle)] bg-[var(--bg-panel)]">
            <button type="button" className={collapseBtn} onClick={toggleTools} aria-label={t('camAi.ws.showTools')} title={`${t('camAi.ws.showTools')}  [`}>
              <SidebarLeftExpand size={18} stroke={1.6} />
            </button>
          </div>
        ))}

        <main className="flex-1 min-w-0 flex flex-col" aria-label={t('camAi.ws.viewport')}>
          {/* The clampings, one chip each. */}
          {(result || setupNodes.length > 0) && (
            <div className="h-12 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--border-subtle)] overflow-x-auto hide-scrollbar">
              {narrow && (
                <button type="button" className={barBtn} onClick={toggleTools} aria-expanded={toolsOpen}>
                  <SidebarLeftExpand size={16} stroke={1.6} aria-hidden /> {t('camAi.ws.tools')}
                </button>
              )}
              {(result ? result.setups.map((_, i) => i) : setupNodes.map((x) => x.i)).map((i) => {
                const on = (sel.kind === 'setup' || sel.kind === 'tool') && sel.i === i;
                const st = stepName(i);
                return (
                  <button key={i} type="button" onClick={() => { setOpTab(i); setSel({ kind: 'setup', i }); }} aria-pressed={on} className={`no-glass shrink-0 h-8 inline-flex items-center gap-2 px-2.5 rounded-[8px] border text-[13px] ${on ? 'border-[var(--accent-primary)]/60 bg-[var(--accent-primary)]/12 text-[var(--text-primary)]' : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}>
                    <span className={`w-[18px] h-[18px] rounded-full grid place-items-center text-xs font-semibold ${on ? 'bg-[var(--accent-primary)] text-white' : 'bg-[rgba(var(--ov),0.12)]'}`}>{st.n}</span>
                    {st.turn}
                    {st.rest && (
                      <span className="inline-flex items-center gap-1 tabular-nums">
                        <Parallels size={14} stroke={1.6} aria-hidden /> {st.rest}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          <div className="relative flex-1 min-h-0">
            {/* Every change since the program was made, and the one way to make it again with them (the owner). */}
            {result && shownChanges.length > 0 && (
              <section aria-labelledby="cam-changes" className="absolute z-20 right-3 bottom-[124px] w-[min(320px,calc(100%-1.5rem))] rounded-[12px] border border-[var(--blue-500)]/40 bg-[var(--bg-panel)]/95 backdrop-blur shadow-[0_8px_24px_rgba(0,0,0,0.45)] p-3 space-y-2">
                <h3 id="cam-changes" className="text-[13px] font-semibold text-[var(--text-primary)]">{t('camAi.changes.title', { count: shownChanges.length })}</h3>
                <ol className="max-h-40 overflow-y-auto list-decimal pl-5 space-y-1 text-xs text-[var(--text-secondary)]" aria-live="polite">
                  {shownChanges.map((c) => (
                    <li key={c.id}>{c.label}</li>
                  ))}
                </ol>
                <div className="flex items-center justify-between gap-2">
                  <button type="button" className="no-glass min-h-9 px-1 text-xs text-[var(--text-secondary)] underline underline-offset-2 hover:text-[var(--text-primary)] disabled:opacity-40" disabled={busy || checking || !shownChanges.some((c) => c.undo)} onClick={undoLast} title={t('camAi.changes.undoHint')}>
                    {t('camAi.changes.undo')}
                  </button>
                  <button type="button" className="btn-primary h-9 px-4 text-[13px] inline-flex items-center gap-1.5" disabled={busy || checking} onClick={makeAgain}>
                    <RefreshCw size={14} className={busy ? 'animate-spin motion-reduce:animate-none' : ''} aria-hidden /> {t('camAi.changes.make')}
                  </button>
                </div>
              </section>
            )}
            {prep && chosen ? (
              <>
                {/* The simulation stays alive under the clamping 1 editor: its cut part and the part built ahead are kept
                    (coming back must not cut the program again). */}
                {result && (
                  <div className={clampMode ? 'invisible pointer-events-none absolute inset-0' : 'contents'} aria-hidden={clampMode || undefined}>
                <Suspense fallback={null}>
                  <CamSim
                    hidden={clampMode}
                    code={result.code}
                    brand={machine?.brand}
                    model={model}
                    pieces={result.pieces}
                    focus={simFocus}
                    onPickTool={(i, tool) => {
                      const op = result.setups[i]?.ops.find((o) => o.tool === tool);
                      if (op) setSel({ kind: 'tool', i, code: op.code });
                    }}
                    selected={sel.kind === 'tool' ? { setup: sel.i, tool: result.setups[sel.i]?.ops.find((o) => o.code === sel.code)?.tool ?? -1 } : null}
                    runLabel={runLabel}
                    stepLabel={(i) => { const st = stepName(i); return `OP${(i + 1) * 10} · ${st.turn}${st.rest ? ` · ${st.rest}` : ''}`; }}
                    parallels={parallelsText}
                    previews={previews}
                    nx={nx}
                    measure={{ on: measuring, mode: measureMode, onMeasure: setMeasured }}
                    onMeasureToggle={() => { setMeasuring((x) => !x); setMeasured(null); }}
                  />
                </Suspense>
                  </div>
                )}
                {(!result || clampMode) && (
                <div className="absolute inset-0">
            <Suspense fallback={null}>
              <CamPartView
                tris={prep.tris}
                R={chosen.R}
                raw={raw}
                blank={result?.blank ?? sideBlank}
                picks={result || busy ? [] : picks}
                picking={result ? null : picking}
                onPick={pickFace}
                finish={{ on: pickWalls && !pickWhite && !result && !busy, picked: finishTris, onToggle: toggleWall }}
                white={{ on: pickWhite && !result && !busy, side: partType === 'topPlate' ? white : undefined, onPick: (side) => choose(() => { setWhite(side); setPickWhite(false); }) }}
                measure={measuring ? { mode: measureMode, onMeasure: setMeasured } : null}
                paths={paths.filter((p) => !p.key || !skipDraft.includes(p.key))}
                ghosts={result ? [...ghosts, ...live.paths].filter((p) => p.key && skipDraft.includes(p.key)) : []}
                ghostOn={ghostOn}
                onPathMenu={
                  result
                    ? (p) => {
                        const at = live.paths.find((x) => x === p);
                        if (!at?.tool) return;
                        setSwapAsk(at.tool);
                        setSel({ kind: 'tool', i: at.setup, code: at.tool });
                      }
                    : undefined
                }
                clamp={clampMode && cale1 !== null ? { cale: cale1, at: cale1, open: jaw.open, slide: jaw.slide, next: nextHint, flash, bad: !!refused1, stop: stop1, y: laterX[0]?.y, yp: laterX[0]?.yp } : null}
                onClamp={clampAct}
                label={clampMode ? t('camAi.clamp1.view') : picking !== null && !result ? t('camAi.view3d') : t('camAi.live.view')}
                className="h-full rounded-none bg-transparent"
              />
            </Suspense>
                </div>
                )}
              </>
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
                <span className="text-[var(--text-secondary)]">{t('camAi.dropHint')}</span>
              </button>
            </div>
            )}
            {prep && chosen && <MeasurePanel on={measuring} onToggle={() => { setMeasuring((x) => !x); setMeasured(null); }} mode={measureMode} onMode={setMeasureMode} measured={measured} inSim={!!result && !clampMode} />}
          {/* What the view is doing, top centre. */}
          {prep && !result && !busy && pickWhite && (
            <p className="absolute top-3 left-1/2 -translate-x-1/2 max-w-[90%] flex items-center gap-2 rounded-full px-3 py-1.5 text-xs bg-[var(--bg-panel)]/90 backdrop-blur border border-[var(--border-subtle)] text-[var(--text-primary)] shadow">
              <MousePointerClick size={14} className="text-[var(--blue-text)] shrink-0" aria-hidden />
              {t('camAi.white.hint')}
            </p>
          )}
          {prep && !result && !busy && pickWalls && !pickWhite && (
            <p className="absolute top-3 left-1/2 -translate-x-1/2 max-w-[90%] flex items-center gap-2 rounded-full px-3 py-1.5 text-xs bg-[var(--bg-panel)]/90 backdrop-blur border border-[var(--border-subtle)] text-[var(--text-primary)] shadow">
              <MousePointerClick size={14} className="text-[var(--blue-text)] shrink-0" aria-hidden />
              {t('camAi.finish.hint')}
            </p>
          )}
          {prep && !result && !pickWalls && !pickWhite && picking !== null && (
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
          {prep && !result && (
            <p className="absolute right-3 top-3 flex flex-col gap-1 rounded-[var(--radius-md)] px-2.5 py-2 text-xs bg-[var(--bg-panel)]/85 backdrop-blur border border-[var(--border-subtle)] text-[var(--text-secondary)]" aria-hidden>
              <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-[#2f80ff]/60 mr-1.5 align-middle" />{t('camAi.legend.hover')}</span>
              <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-[#22c55e] mr-1.5 align-middle" />{t('camAi.legend.top')}</span>
              <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-[#f5a524] mr-1.5 align-middle" />{t('camAi.legend.stock')}</span>
              {finishTris.length > 0 && <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-[#22d3ee] mr-1.5 align-middle" />{t('camAi.legend.finish')}</span>}
            </p>
          )}
          </div>
        </main>

        {/* The inspector: what is picked, its values, its operations. */}
        {wide && (rightOpen ? (
          <aside aria-labelledby="cam-props" className="w-[300px] shrink-0 flex flex-col border-l border-[var(--border-subtle)] bg-[var(--bg-panel)]">{inspectorBody}</aside>
        ) : (
          <div className="w-10 shrink-0 flex flex-col items-center pt-2 border-l border-[var(--border-subtle)] bg-[var(--bg-panel)]">
            <button type="button" className={collapseBtn} onClick={toggleInspector} aria-label={t('camAi.ws.showInspector')} title={`${t('camAi.ws.showInspector')}  ]`}>
              <SidebarRightExpand size={18} stroke={1.6} />
            </button>
          </div>
        ))}

        {/* Narrower windows: the same panels as drawers over the viewport. */}
        {!wide && rightDrawer && (
          <aside aria-labelledby="cam-props" className="absolute top-0 right-0 bottom-0 z-30 w-[300px] max-w-[90vw] flex flex-col border-l border-[var(--border-subtle)] bg-[var(--bg-panel)] shadow-[-16px_0_40px_rgba(0,0,0,0.45)]">{inspectorBody}</aside>
        )}
        {narrow && leftDrawer && (
          <nav aria-label={t('camAi.ws.tools')} className="absolute top-0 left-0 bottom-0 z-30 w-[260px] max-w-[90vw] flex flex-col overflow-y-auto border-r border-[var(--border-subtle)] bg-[var(--bg-panel)] shadow-[16px_0_40px_rgba(0,0,0,0.45)]">
            <div className="flex justify-end p-2 pb-0">
              <button type="button" className={collapseBtn} onClick={() => setLeftDrawer(false)} aria-label={t('camAi.ws.close')}>
                <X size={18} stroke={1.6} />
              </button>
            </div>
            {toolList}
          </nav>
        )}
      </div>

      {newProgramDialog()}
      {dropDialog()}
      {leaveDialog()}
      <CamToolDb
        open={dbOpen}
        onOpenChange={setDbOpen}
        stored={toolDb}
        onSaved={setToolDb}
        family={templatesFor ? FAMILY[templatesFor] : undefined}
        // A tool this program uses changed in the database: asked to make it again (item 14).
        onChanged={(code) => {
          const op = result?.setups.flatMap((x) => x.ops).find((o) => o.code === code);
          if (op) addChange({ label: t('camAi.db.usedChanged', { tool: op.tool }) });
        }}
      />
    </div>
  );

  /** What the part is made of (shapes.ts): each named, the shop's French word beside it in grey (you). */
  function shapesList() {
    if (!prep?.shapes) return null;
    const label = (x: Shape) => t(`camAi.shape.${x.kind}`, { d: fmt(x.d ?? 0, 2), depth: fmt(x.depth ?? 0, 1), r: fmt(x.r ?? 0, 1), thread: x.thread ?? '', side: x.side, area: fmt(x.area ?? 0, 0) });
    return (
      <section className="space-y-1.5" aria-labelledby="cam-shapes">
        <h4 id="cam-shapes" className="section-label">{t('camAi.shape.title')}</h4>
        {prep.shapes.length ? (
          <ul className="space-y-1">
            {prep.shapes.map((x, i) => (
              <li key={i} className="flex items-baseline gap-2">
                <span className="flex-1 min-w-0 text-[var(--text-primary)]">
                  {label(x)} <span className="text-[var(--text-secondary)]">({SHAPE_FR[x.kind]})</span>
                </span>
                {x.count > 1 && <span className="text-xs text-[var(--text-secondary)] tabular-nums">{t('camAi.shape.count', { n: x.count })}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[var(--text-secondary)]">{t('camAi.shape.none')}</p>
        )}
        {prep.shapes.some((x) => x.kind === 'tapped') && <p className="text-xs text-[var(--text-secondary)]">{t('camAi.shape.tappedHint')}</p>}
      </section>
    );
  }

  /** Part type, machine and material: in the New program dialog and the Part's properties. */
  function whiteFields() {
    if (partType !== 'topPlate') return null;
    return (
      <section className="space-y-1.5" aria-labelledby={`cam-white-${sel.kind}`}>
        <h4 id={`cam-white-${sel.kind}`} className="section-label">{t('camAi.white.title')}</h4>
        <p className="text-[var(--text-secondary)]">{t('camAi.white.help')}</p>
        <p className="text-[var(--text-primary)]" aria-live="polite">{white ? t('camAi.white.picked', { side: white }) : t('camAi.white.none')}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={`${pickWhite ? 'btn-primary' : 'btn-secondary'} text-xs min-h-9 px-3`} aria-pressed={pickWhite} onClick={() => setPickWhite((v) => !v)} disabled={busy || !!result}>
            {pickWhite ? t('camAi.white.cancel') : t('camAi.white.pick')}
          </button>
          {white && (
            <button type="button" className="btn-secondary text-xs min-h-9 px-3" onClick={() => choose(() => setWhite(undefined))} disabled={busy}>
              {t('camAi.white.clear')}
            </button>
          )}
        </div>
      </section>
    );
  }

  function finishFields() {
    return (
      <section className="space-y-1.5" aria-labelledby={`cam-finish-${sel.kind}`}>
        <h4 id={`cam-finish-${sel.kind}`} className="section-label">{t('camAi.finish.title')}</h4>
        <p className="text-[var(--text-secondary)]">{t('camAi.finish.help')}{partType === 'sealCage' ? ` ${t('camAi.finish.sealCage')}` : ''}</p>
        <p className="text-[var(--text-primary)]" aria-live="polite">{t('camAi.finish.count', { count: finishWalls.length })}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={`${pickWalls ? 'btn-primary' : 'btn-secondary'} text-xs min-h-9 px-3`} aria-pressed={pickWalls} onClick={() => setPickWalls((v) => !v)} disabled={busy || !!result}>
            {pickWalls ? t('camAi.finish.done') : t('camAi.finish.pick')}
          </button>
          {finishTris.length > 0 && (
            <button type="button" className="btn-secondary text-xs min-h-9 px-3" onClick={() => choose(() => setFinishWalls([]))} disabled={busy}>
              {t('camAi.finish.clear')}
            </button>
          )}
        </div>
      </section>
    );
  }

  function partFields() {
    return (
      <div className="space-y-3">
        <label className="block space-y-1">
          <span className="section-label block">{t('camAi.part.type')}</span>
          <select className="aurora-input w-full text-xs cursor-pointer" value={partType} onChange={(e) => choosePartType(e.target.value as PartType)} disabled={busy}>
            <option value="" disabled className="bg-[var(--bg-panel)]">{t('camAi.part.choose')}</option>
            {PART_TYPES.map((p) => (
              <option key={p} value={p} className="bg-[var(--bg-panel)]">{t(`camAi.part.types.${p}`)}</option>
            ))}
          </select>
          <span className="block text-xs text-[var(--text-secondary)]">{t('camAi.part.typeHint')}</span>
        </label>
        <label className="block space-y-1">
          <span className="section-label block">{t('camAi.machine')}</span>
          <select className="aurora-input w-full text-xs cursor-pointer" value={machine?.id ?? ''} onChange={(e) => choose(() => setMachineId(e.target.value))} disabled={busy}>
            {toolMachines.map((m) => (
              <option key={m.id} value={m.id} className="bg-[var(--bg-panel)]">{t('remapper:controls.machineOption', { name: m.name, count: (toolbox[m.id] || []).length })}</option>
            ))}
          </select>
        </label>
        {!tools.length && machine && <p className="text-xs text-[var(--orange-text)]">{t('camAi.noTools', { name: machine.name })}</p>}
        {wrongCooling && machine && (
          <p className="text-xs text-[var(--orange-text)]" role="alert">{t(need === 'air' ? 'remapper:alerts.needsAir' : 'remapper:alerts.needsLubricant', { machine: machine.name })}</p>
        )}
        <label className="block space-y-1">
          <span className="section-label block">{t('camAi.material')}</span>
          <select className="aurora-input w-full text-xs cursor-pointer" value={material} onChange={(e) => choose(() => setMaterial(e.target.value as CamMaterial | 'INOX' | 'OTHER'))} disabled={busy}>
            <option value="" disabled className="bg-[var(--bg-panel)]">{t('camAi.part.choose')}</option>
            {CAM_MATERIALS.map((m) => (
              <option key={m} value={m} className="bg-[var(--bg-panel)]">{m}</option>
            ))}
            <option value="INOX" className="bg-[var(--bg-panel)]">{t('camAi.inox')}</option>
            <option value="OTHER" className="bg-[var(--bg-panel)]">{t('camAi.otherMaterial')}</option>
          </select>
        </label>
        {material === 'INOX' && (
          <div className="space-y-2 rounded-[var(--radius-md)] border border-[#f5b942]/40 bg-[#f5b942]/8 p-2.5" role="alert">
            <p className="text-xs text-[var(--text-primary)]">{t('camAi.inoxAsk')}</p>
            <button type="button" onClick={() => setMaterial('MS')} className="btn-primary text-xs min-h-9 px-3">{t('camAi.useMs')}</button>
          </div>
        )}
        {material === 'OTHER' && (
          <label className="block space-y-1">
            <span className="section-label block">{t('camAi.family')}</span>
            <select className="aurora-input w-full text-xs cursor-pointer" value={family} onChange={(e) => choose(() => setFamily(e.target.value as Family))} disabled={busy}>
              {(['ALU', 'POM', 'FH'] as const).map((f) => (
                <option key={f} value={f} className="bg-[var(--bg-panel)]">{t(`camAi.families.${f}`)}</option>
              ))}
            </select>
          </label>
        )}
      </div>
    );
  }

  /** Leaving with a program made or being made: asked first (nothing of it is kept). */
  function leaveDialog() {
    return (
      <Dialog.Root open={!!leaveAsk} onOpenChange={(o) => !o && setLeaveAsk(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[1000] bg-black/45 backdrop-blur-[2px]" />
          <Dialog.Content className="glass-modal fixed z-[1001] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[26rem] max-w-[calc(100vw-2rem)] p-5 space-y-4">
            <Dialog.Title className="text-sm font-semibold text-[var(--text-primary)]">{t('camAi.ws.leaveTitle')}</Dialog.Title>
            <Dialog.Description className="text-xs text-[var(--text-secondary)]">{t('camAi.ws.leaveBody')}</Dialog.Description>
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <button type="button" className="btn-secondary text-xs min-h-11 px-4">{t('camAi.ws.leaveStay')}</button>
              </Dialog.Close>
              <button
                type="button"
                className="btn-primary text-xs min-h-11 px-4"
                onClick={() => {
                  const go = leaveAsk?.go;
                  setLeaveAsk(null);
                  go?.();
                }}
              >
                {leaveAsk?.send ? t('camAi.send') : t('camAi.ws.leaveConfirm')}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }

  /** Deleting a tool from a clamping: asked first (its path and tool change go, the program is made again). */
  function dropDialog() {
    return (
      <Dialog.Root open={!!dropAsk} onOpenChange={(o) => !o && setDropAsk(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[1000] bg-black/45 backdrop-blur-[2px]" />
          <Dialog.Content className="glass-modal fixed z-[1001] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[26rem] max-w-[calc(100vw-2rem)] p-5 space-y-4">
            <Dialog.Title className="text-sm font-semibold text-[var(--text-primary)]">{dropAsk && t('camAi.ws.deleteTitle', { tool: dropAsk.tool, n: dropAsk.i + 1 })}</Dialog.Title>
            <Dialog.Description className="text-xs text-[var(--text-secondary)]">{t('camAi.ws.deleteBody')}</Dialog.Description>
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <button type="button" className="btn-secondary text-xs min-h-11 px-4">{t('camAi.cancel')}</button>
              </Dialog.Close>
              <button
                type="button"
                className="btn-primary text-xs min-h-11 px-4 inline-flex items-center gap-1.5"
                onClick={() => {
                  if (dropAsk) dropTool(dropAsk.i, dropAsk.code);
                  setDropAsk(null);
                }}
              >
                <Trash size={14} stroke={1.8} aria-hidden />
                {t('camAi.ws.deleteConfirm')}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }

  /** New program: the model, then what the part is and where it is made. */
  function newProgramDialog() {
    return (
      <Dialog.Root open={dialog} onOpenChange={setDialog}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[1000] bg-black/45 backdrop-blur-[2px]" />
          <Dialog.Content className={`glass-modal fixed z-[1001] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 ${prep ? 'w-[52rem]' : 'w-[30rem]'} max-w-[calc(100vw-2rem)] max-h-[90vh] overflow-y-auto p-5 space-y-4`}>
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
              <span className="text-[var(--text-secondary)]">{model ? `${model.bytes.length < 1048576 ? `${fmt(model.bytes.length / 1024, 0)} kB` : `${fmt(model.bytes.length / 1048576, 1)} MB`} · ${t('camAi.change')}` : t('camAi.dropHint')}</span>
            </button>
            {/* A file that is not a model: said here, where it was chosen (the inspector is behind the dialog). */}
            {run.state === 'error' && run.error !== 'failed' && run.error !== 'thinBlank' && run.error !== 'toolDb' && (
              <p className="badge-danger text-xs py-1.5 px-3" role="alert">{t(`camAi.modelErrors.${run.error}`)}</p>
            )}
            {prep && (
              // The part in 3D beside its choices (item 16): turned with the mouse, as it was read.
              <div className="grid gap-4 md:grid-cols-[1fr_18rem]">
                <div className="h-64 md:h-[22rem] rounded-[var(--radius-md)] overflow-hidden border border-[var(--border-subtle)] bg-[radial-gradient(ellipse_at_50%_40%,#16213A_0%,#0B1222_72%)]">
                  <Suspense fallback={null}>
                    <CamPartView tris={prep.tris} R={IDENTITY} raw={null} picks={[]} picking={null} label={t('camAi.view3d')} className="w-full h-full" />
                  </Suspense>
                </div>
                <div className="space-y-3 min-w-0">
                  {prep.title && <p className="text-xs"><span className="text-[var(--text-secondary)]">{t('camAi.part.title')}: </span><span className="font-medium text-[var(--text-primary)]">{prep.title}</span></p>}
                  {partFields()}
                </div>
              </div>
            )}
            <div className="flex items-center justify-end gap-2">
              {prep && !partType && <p className="mr-auto text-xs text-[var(--text-secondary)]">{t('camAi.ws.createNeeds')}</p>}
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

/** Clamping 1's parallels and vise (you, Beta 2): what holds it, CAM AI's own, a button for every move the 3D view takes. */
/** The spacers a clamping's panel offers (mm): in the moving jaw (CAM AI's choice, none, the shop's sizes), and at the fixed jaw (special cases). */
const Y_SPACERS = ['auto', 0, 15, 20, 50] as const;
const YP_SPACERS = [0, 15, 20, 50] as const;
/** The spacer at the fixed jaw (Y+): not used for now (the owner, docs/COMMON-GROUND.md Q005); the planner keeps it. */
const Y_PLUS = false;

/** A row of choices, one picked (radio buttons), for the clamping panels. */
function Seg<V extends string | number>({ legend, value, options, onChange }: { legend: string; value: V; options: { v: V; label: string }[]; onChange: (v: V) => void }) {
  return (
    <fieldset className="space-y-1">
      <legend className="text-xs text-[var(--text-secondary)]">{legend}</legend>
      <div className="inline-flex flex-wrap rounded-[var(--radius-md)] border border-[var(--border-subtle)] p-0.5" role="radiogroup" aria-label={legend}>
        {options.map((o) => (
          <button key={String(o.v)} type="button" role="radio" aria-checked={value === o.v} onClick={() => onChange(o.v)} className={`no-glass text-xs px-3 min-h-9 rounded-[calc(var(--radius-md)-2px)] ${value === o.v ? 'bg-[var(--accent-primary)]/15 text-[var(--text-primary)] font-medium' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}>
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** The parallels' heights to pick from, as a list (no wheel, no stepping). */
function ParallelsPick({ value, heights, label, onChange }: { value: string; heights: { key: string; label: string }[]; label: string; onChange: (key: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
      {label}
      <select className="aurora-input w-full min-w-0 h-9 py-0 px-2 text-[13px] cursor-pointer" value={value} title={heights.find((h) => h.key === value)?.label} onChange={(e) => onChange(e.target.value)}>
        {heights.map((h) => (
          <option key={h.key} value={h.key} className="bg-[var(--bg-panel)]">{h.label}</option>
        ))}
      </select>
    </label>
  );
}

/** "Adjust this clamping" (item 12): the clamping's own settings, folded away until asked for. */
function AdjustToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = useTranslation('cam');
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} className="btn-secondary w-full justify-center text-xs min-h-9 px-3 flex items-center gap-2">
      <Settings2 size={14} aria-hidden /> {open ? t('camAi.hold.close') : t('camAi.hold.adjust')}
    </button>
  );
}

function ClampPanel({ cale, own, mine, grip, intoPart, seam, jaw, pending, refused, stop, stopPending, onStop, onAct, onOwn, cales, onCale, y, onY, yp, onYp, made, onOpenChange }: { cale: number; own: number | null; mine: boolean; grip: number; intoPart: number; seam: boolean; jaw: { open: number; slide: number }; pending?: number; refused: ReturnType<typeof whyNot>; stop: 0 | 15 | 50; stopPending: boolean; onStop: (v: 0 | 15 | 50) => void; onAct: (a: ClampAct) => void; onOwn: () => void; cales: number[]; onCale: (v: number) => void; y: 0 | 15 | 20 | 50 | undefined; onY: (v: 0 | 15 | 20 | 50 | undefined) => void; yp: 15 | 20 | 50 | undefined; onYp: (v: 15 | 20 | 50 | undefined) => void; made: boolean; onOpenChange?: (open: boolean) => void }) {
  const { t } = useTranslation('cam');
  const btn = 'btn-secondary text-xs min-h-11 px-2 flex items-center justify-center gap-1.5';
  // Open while preparing; once a program is made, folded until asked for.
  const [open, setOpen] = useState(!made);
  const heights = [...new Set([...cales, cale])].sort((p, q) => q - p).map((c) => ({ key: String(c), label: c === 0 ? t('camAi.hold.table') : t('camAi.hold.mm', { mm: fmt(c, 0) }) }));
  return (
    <section aria-labelledby="clamp1-title" className="space-y-2 border-t border-[var(--border-subtle)] pt-2">
      <h3 id="clamp1-title" className="section-label">{t('camAi.clamp1.title')}</h3>
      <p className="text-[var(--text-primary)]" aria-live="polite">
        {cale === 0 ? t('camAi.clamp1.none') : t('camAi.clamp1.on', { cale: fmt(cale, 0), grip: fmt(grip, 0) })}
      </p>
      {pending !== undefined && <p className="text-[var(--text-primary)]">{pending === 0 ? t('camAi.clamp1.laterTable') : t('camAi.clamp1.later', { cale: fmt(pending, 0) })}</p>}
      {own !== null && (
        <p className="flex flex-wrap items-center gap-2 text-[var(--text-secondary)]">
          {t('camAi.clamp1.own', { cale: fmt(own, 0) })}
          {mine && <button type="button" onClick={onOwn} className="btn-secondary text-xs min-h-9 px-2">{t('camAi.clamp1.useOwn')}</button>}
        </p>
      )}
      {refused && <p className="flex gap-2 text-[#facc15]" role="alert"><AlertTriangle size={15} className="shrink-0" aria-hidden />{t(`camAi.clamp1.refused.${refused}`, { cale: fmt(cale, 0) })}</p>}
      <AdjustToggle open={open} onToggle={() => { setOpen(!open); onOpenChange?.(!open); }} />
      {open && (
        <div className="space-y-3">
          <ParallelsPick label={t('camAi.hold.parallels')} value={String(cale)} heights={heights} onChange={(k) => onCale(Number(k))} />
          <Seg legend={t('camAi.hold.stopX')} value={stop} options={([0, 15, 50] as const).map((v) => ({ v, label: v ? t('camAi.clamp1.stopMm', { mm: v }) : t('camAi.clamp1.stopNone') }))} onChange={onStop} />
          {stopPending && <p className="text-[var(--text-primary)]">{stop ? t('camAi.clamp1.laterStop', { mm: stop }) : t('camAi.clamp1.laterStopNone')}</p>}
          <Seg legend={t('camAi.hold.spacerY')} value={y ?? 'auto'} options={Y_SPACERS.map((v) => ({ v, label: v === 'auto' ? t('camAi.hold.auto') : v ? t('camAi.clamp1.stopMm', { mm: v }) : t('camAi.hold.none') }))} onChange={(v) => onY(v === 'auto' ? undefined : v)} />
          <p className="text-xs text-[var(--text-secondary)]">{t('camAi.hold.yHint')}</p>
          {Y_PLUS && <Seg legend={t('camAi.hold.spacerYp')} value={yp ?? 0} options={YP_SPACERS.map((v) => ({ v, label: v ? t('camAi.clamp1.stopMm', { mm: v }) : t('camAi.hold.none') }))} onChange={(v) => onYp(v || undefined)} />}
          {Y_PLUS && yp !== undefined && <p className="text-xs text-[var(--orange-text)]" role="status">{t('camAi.hold.ypHint')}</p>}
          <div className="grid grid-cols-2 gap-1.5">
            <button type="button" className={btn} onClick={() => onAct('back')}><ArrowUp size={14} aria-hidden />{t('camAi.clamp1.back')}</button>
            <button type="button" className={btn} onClick={() => onAct('forward')}><ArrowDown size={14} aria-hidden />{t('camAi.clamp1.forward')}</button>
            <button type="button" className={btn} onClick={() => onAct('open')}><JawsOpen size={14} aria-hidden />{t('camAi.clamp1.open')}</button>
            <button type="button" className={btn} onClick={() => onAct('close')}><JawsClose size={14} aria-hidden />{t('camAi.clamp1.close')}</button>
          </div>
          <p className="text-xs text-[var(--text-secondary)] tabular-nums">{t('camAi.clamp1.jaw', { open: fmt(jaw.open, 0), slide: fmt(-jaw.slide || 0, 0) })}</p>
          <p className="text-xs text-[var(--text-secondary)]">{t('camAi.clamp1.hint')}</p>
        </div>
      )}
      {cale === 0 && <p className="text-[var(--text-secondary)]" role="status">{t('camAi.clamp1.noneWarn')}</p>}
      {!refused && cale > 0 && grip < GRIP_WANT && <p className="flex gap-2 text-[#facc15]" role="status"><AlertTriangle size={15} className="shrink-0" aria-hidden />{t('camAi.clamp1.lowGrip', { grip: fmt(grip, 0) })}</p>}
      {!refused && intoPart > 0.05 && <p className="flex gap-2 text-[var(--orange-text)]" role="status"><AlertTriangle size={15} className="shrink-0" aria-hidden />{t('camAi.clamp1.intoPart', { mm: fmt(intoPart, 1) })}</p>}
      {seam && <p className="text-[var(--text-secondary)]">{t('camAi.note.clampSeam', { setup: 1, cale: fmt(cale, 0) })}</p>}
    </section>
  );
}

/** A later clamping's spacers and side up, as the designer chose them. */
type LaterX = { stop?: 15 | 50; y?: 0 | 15 | 20 | 50; yp?: 15 | 20 | 50; side?: string; flip?: 'X' | 'Y'; quarter?: 1 | 2 | 3 };
/** A later clamping's hold: parallels of that height (0: the table), or resting on the jaw tops by a face that deep. */
/** On parallels by its bottom, on the jaw tops by a face, or on parallels by a step (you: the thickness where they touch). */
type Hold = { cale: number } | { jaw: number } | { step: number };
const holdKey = (h: Hold) => ('cale' in h ? `c${h.cale}` : 'jaw' in h ? `j${h.jaw}` : `s${h.step}`);
/** The same hold: a step within 0.05 mm is the same step (the planner takes the model's step that near the one typed). */
const sameHold = (a: Hold, b: Hold) => ('step' in a && 'step' in b ? Math.abs(a.step - b.step) < 0.05 : holdKey(a) === holdKey(b));

/**
 * A later clamping's hold, on the program made (what it holds is what the clampings before left): its parallels, the
 * table, or the jaw tops by one of its faces (you), and its spacers (item 3); for the next time it is made, previewed
 * in the 3D view until then.
 */
/** A clamping's turn by hand (you): +90 / -90 about the machine's X and Y, the presses adding up, shown on your model. */
function TurnPanel({ n, made, turned, tris, used, onPress, onOwn }: { n: number; made: Mat3; turned?: { R: Mat3; presses: string[] }; tris: Float32Array; /** The sides up in the clampings before it. */ used: string[]; onPress: (p: string) => void; onOwn: () => void }) {
  const { t } = useTranslation('cam');
  const R = turned?.R ?? made;
  const pending = !!turned && turned.R.some((v, k) => v !== made[k]);
  const up = upOf(R);
  const deg = (p: string) => (p[1] === '+' ? '+90°' : '−90°');
  return (
    <section aria-labelledby={`turn${n}-title`} className="space-y-2 border-t border-[var(--border-subtle)] pt-2">
      <h3 id={`turn${n}-title`} className="section-label">{t('camAi.turn.title')}</h3>
      <Suspense fallback={<div className="h-[170px] rounded-[8px] bg-[#0B1222]" aria-hidden />}>
        <CamTurnGhost tris={tris} made={made} turned={R} label={t('camAi.turn.ghost', { side: up })} />
      </Suspense>
      <div className="grid grid-cols-4 gap-1.5" role="group" aria-label={t('camAi.turn.title')}>
        {['X+', 'Y+', 'X-', 'Y-'].map((p) => (
          <button key={p} type="button" className="btn-secondary min-h-11 px-1 text-xs font-mono" onClick={() => onPress(p)} aria-label={t('camAi.turn.press', { axis: p[0], deg: deg(p) })} title={t('camAi.turn.press', { axis: p[0], deg: deg(p) })}>
            {deg(p).replace('°', '')} {p[0]}
          </button>
        ))}
      </div>
      <p className="text-[var(--text-primary)]" aria-live="polite">
        <span className="font-mono">{t('camAi.turn.up', { side: up })}</span>
        {turned?.presses.length ? ` · ${t('camAi.turn.by', { turns: pressText(turned.presses) || t('camAi.turn.none') })}` : ''}
        {pending ? ` · ${t('camAi.turn.pending')}` : ''}
      </p>
      {used.includes(up) && <p className="text-xs text-[var(--orange-text)]" role="status">{t('camAi.turn.taken', { side: up })}</p>}
      <p className="text-xs text-[var(--text-secondary)]">{t('camAi.turn.hint')}</p>
      {turned && (
        <button type="button" onClick={onOwn} className="btn-secondary text-xs min-h-9 px-2">
          {t('camAi.turn.own')}
        </button>
      )}
    </section>
  );
}

function LaterClampPanel({ n, made, used, asked, spacers, madeTurn, emptySide, refusals, onAsk, openAt }: { n: number; /** Opened from its OP's settings button. */ openAt?: boolean; /** The turn the program shown was made with. */ madeTurn: Pick<LaterX, 'flip' | 'quarter'>; made: CamSummary['setups'][number]; /** The sides of the clampings before it. */ used: string[]; asked: Hold | undefined; /** The side asked had nothing left to cut (the program made says so). */ emptySide: boolean; /** What the program made refused of this clamping's choices. */ refusals: CamSummary['notes']; spacers: LaterX; onAsk: (v: Hold | null, x: LaterX) => void }) {
  const { t } = useTranslation('cam');
  const [open, setOpen] = useState(!!openAt || asked !== undefined || Object.keys(spacers).length > 0);
  const steps: Hold[] = [...made.cales.map((c) => ({ hold: { cale: c } as Hold, level: c })), ...made.jaws.map((j) => ({ hold: { jaw: j.depth } as Hold, level: j.cale })), ...made.steps.map((s) => ({ hold: { step: s.depth } as Hold, level: s.cale }))].sort((p, q) => Number('jaw' in p.hold) - Number('jaw' in q.hold) || q.level - p.level).map((x) => x.hold);
  const mine: Hold = made.onJaw !== undefined ? { jaw: made.onJaw } : made.step !== undefined ? { step: made.step } : { cale: made.cale };
  // The thickness where the parallels touch, typed (you: as the engineers write it).
  const [thick, setThick] = useState(asked && 'step' in asked ? String(asked.step) : '');
  const [thickBad, setThickBad] = useState(false);
  const now = asked ?? mine;
  // A choice the program made does not have yet (made again, it shows as made; a side with nothing to cut is said apart).
  const spacerOf = (at: string) => Number(made.notes.join(' ').match(new RegExp(`(\\d+) MM ZWISCHENLAGE IN ${at.replace('+', '\\+')}`))?.[1] ?? 0);
  const pending =
    (asked !== undefined && !sameHold(asked, mine)) ||
    (spacers.side !== undefined && spacers.side !== made.side && !emptySide) ||
    (spacers.stop ?? 0) !== spacerOf('X-') ||
    (spacers.y !== undefined && spacers.y !== spacerOf('Y-')) ||
    (spacers.yp ?? 0) !== spacerOf('Y+') ||
    spacers.flip !== madeTurn.flip ||
    spacers.quarter !== madeTurn.quarter;
  const all = steps.some((h) => sameHold(h, now)) ? steps : [now, ...steps];
  const nowKey = holdKey(all.find((h) => sameHold(h, now))!);
  // A step the program made does not know (typed, not made yet): its parallels are not known either, never guessed.
  const stepParallels = (h: { step: number }) => made.steps.find((x) => x.depth === h.step)?.cale ?? (made.step !== undefined && Math.abs(made.step - h.step) < 0.05 ? made.cale : undefined);
  const said = (h: Hold) => ('jaw' in h ? t('camAi.hold.jaw', { depth: fmt(h.jaw, 1) }) : 'step' in h ? (stepParallels(h) === undefined ? t('camAi.hold.stepOnly', { depth: fmt(h.step, 1) }) : t('camAi.hold.step', { depth: fmt(h.step, 1), cale: fmt(stepParallels(h)!, 0) })) : h.cale === 0 ? t('camAi.hold.table') : t('camAi.hold.mm', { mm: fmt(h.cale, 0) }));
  const pickHold = (key: string) => {
    const h = all.find((x) => holdKey(x) === key)!;
    onAsk(sameHold(h, mine) && made.own === undefined ? null : h, spacers);
  };
  const setX = (x: LaterX) => onAsk(asked ?? null, Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined)));
  return (
    <section aria-labelledby={`clamp${n}-title`} className="space-y-2 border-t border-[var(--border-subtle)] pt-2">
      <h3 id={`clamp${n}-title`} className="section-label">{t('camAi.clamp1.title')}</h3>
      <p className="text-[var(--text-primary)]">
        {made.onJaw !== undefined ? t('camAi.clamp1.onJaw', { depth: fmt(made.onJaw, 1), grip: fmt(made.grip, 0) }) : made.step !== undefined ? t('camAi.clamp1.onStep', { cale: fmt(made.cale, 0), depth: fmt(made.step, 1), grip: fmt(made.grip, 0) }) : made.cale === 0 ? t('camAi.clamp1.onTable') : t('camAi.clamp1.on', { cale: fmt(made.cale, 0), grip: fmt(made.grip, 0) })}
      </p>
      {made.own !== undefined && <p className="text-[var(--text-secondary)]">{t('camAi.clamp1.own', { cale: fmt(made.own, 0) })}</p>}
      <AdjustToggle open={open} onToggle={() => setOpen((o) => !o)} />
      {open && (
        <div className="space-y-3">
          {/* The side up and its turn: the turn buttons above (TurnPanel), the presses adding up. */}
          {emptySide && <p className="text-xs text-[var(--orange-text)]" role="status">{t('camAi.note.sideEmpty', { side: spacers.side })}</p>}
          {refusals.map(({ key, ...v }, i) => (
            <p key={i} className="text-xs text-[var(--orange-text)]" role="status">{t(`camAi.note.${key}`, v)}</p>
          ))}
          <ParallelsPick label={t('camAi.hold.parallels')} value={nowKey} heights={all.map((h) => ({ key: holdKey(h), label: said(h) }))} onChange={pickHold} />
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const v = Number(thick.replace(',', '.'));
              const near = made.steps.find((x) => Math.abs(x.depth - v) < 0.05);
              const okV = Number.isFinite(v) && v > 0 && v <= 200;
              setThickBad(!okV);
              if (okV) onAsk({ step: near ? near.depth : Math.round(v * 100) / 100 }, spacers);
            }}
          >
            <label className="flex-1 min-w-0 text-xs text-[var(--text-secondary)]">
              {t('camAi.hold.typeStep')}
              <input type="text" inputMode="decimal" value={thick} onChange={(e) => { setThick(e.target.value); setThickBad(false); }} className="aurora-input mt-1 w-full h-9 px-2 text-[13px] tabular-nums" aria-invalid={thickBad || undefined} aria-describedby={`step${n}-hint`} />
            </label>
            <button type="submit" className="btn-secondary text-xs min-h-9 px-3" disabled={!thick.trim()}>{t('camAi.hold.useStep')}</button>
          </form>
          {thickBad && <p className="text-xs text-[var(--orange-text)]" role="alert">{t('camAi.hold.stepBad')}</p>}
          <p id={`step${n}-hint`} className="text-xs text-[var(--text-secondary)]">{t('camAi.hold.stepHint')}</p>
          <Seg legend={t('camAi.hold.stopX')} value={spacers.stop ?? 0} options={([0, 15, 50] as const).map((v) => ({ v, label: v ? t('camAi.clamp1.stopMm', { mm: v }) : t('camAi.clamp1.stopNone') }))} onChange={(v) => setX({ ...spacers, stop: v || undefined })} />
          <Seg legend={t('camAi.hold.spacerY')} value={spacers.y ?? 'auto'} options={Y_SPACERS.map((v) => ({ v, label: v === 'auto' ? t('camAi.hold.auto') : v ? t('camAi.clamp1.stopMm', { mm: v }) : t('camAi.hold.none') }))} onChange={(v) => setX({ ...spacers, y: v === 'auto' ? undefined : v })} />
          <p className="text-xs text-[var(--text-secondary)]">{t('camAi.hold.yHint')}</p>
          {Y_PLUS && <Seg legend={t('camAi.hold.spacerYp')} value={spacers.yp ?? 0} options={YP_SPACERS.map((v) => ({ v, label: v ? t('camAi.clamp1.stopMm', { mm: v }) : t('camAi.hold.none') }))} onChange={(v) => setX({ ...spacers, yp: v || undefined })} />}
          {Y_PLUS && spacers.yp !== undefined && <p className="text-xs text-[var(--orange-text)]" role="status">{t('camAi.hold.ypHint')}</p>}
          {(asked !== undefined || Object.keys(spacers).length > 0) && (
            <p className="flex flex-wrap items-center gap-2 text-[var(--text-primary)]" aria-live="polite">
              {pending && !refusals.length && t('camAi.hold.preview')}
              <button type="button" onClick={() => onAsk(null, {})} className="btn-secondary text-xs min-h-9 px-2">{t('camAi.clamp1.useOwn')}</button>
            </p>
          )}
        </div>
      )}
      {'cale' in now && now.cale === 0 && <p className="text-[var(--text-secondary)]" role="status">{t('camAi.clamp1.noneWarn')}</p>}
      <p className="text-xs text-[var(--text-secondary)]">{t('camAi.clamp1.laterHint')}</p>
    </section>
  );
}

type Sel = { kind: 'part' } | { kind: 'stock' } | { kind: 'program' } | { kind: 'setup'; i: number } | { kind: 'tool'; i: number; code: string; op?: string };


/** The verdict, once there is a program. */
function useVerdictOrNull(result: CamSummary | null, changed: number, accepted = false) {
  const empty: CamSummary = { code: '', match: 0, minutes: 0, toolChanges: 0, collisions: 0, stops: 0, cales: 0, misplaced: 0, sized: false, gouge: 0, pieces: [], size: [], raw: [], blank: { lo: [], hi: [] }, missing: [], notes: [], nests: [], setups: [] };
  const v = useVerdict(result ?? empty, changed, accepted);
  return result ? v : null;
}

/** The planner's steps as they happen: done, now (with how far along all of it is), still to come. */
function LiveConsole({ live, done, excess }: { live: Live; done: boolean; excess: number[] }) {
  const { t } = useTranslation(['cam', 'remapper', 'common']);
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
  const share = done ? 100 : live.pct;
  // How long it has been working: the console is mounted for each run.
  const [t0] = useState(Date.now);
  const [now, setNow] = useState(t0);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[rgba(var(--ov),0.03)] p-3 space-y-3" role="status" aria-live="polite" aria-label={t('camAi.live.title')}>
      <div className="flex items-center justify-between text-xs">
        <span className="font-semibold text-[var(--text-primary)]">{t('camAi.live.title')}</span>
        <span className="tabular-nums text-[var(--text-secondary)]">
          {share} %<span aria-hidden="true"> · {t('camAi.live.elapsed', { time: fmtTime(Math.floor((now - t0) / 1000)) })}</span>
        </span>
      </div>
      <div className="h-1 rounded-full bg-[rgba(var(--ov),0.08)] overflow-hidden" aria-hidden>
        <div className="h-full bg-[var(--accent-primary)] transition-[width] duration-500" style={{ width: `${Math.max(4, share)}%` }} />
      </div>
      <ol className="space-y-2">
        {rows.map((r) => (
          <li key={r.key} className={`flex items-start gap-2 text-xs ${r.state === 'next' ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)]'}`}>
            {r.state === 'done' ? (
              <CheckCircle2 size={14} className="shrink-0 mt-px text-[var(--green-text,#1fb257)]" aria-hidden />
            ) : r.state === 'now' ? (
              <Loader2 size={14} className="shrink-0 mt-px text-[var(--blue-text)] animate-spin motion-reduce:animate-none" aria-hidden />
            ) : (
              <Circle size={14} className="shrink-0 mt-px" aria-hidden />
            )}
            <span className="flex-1">{r.text}</span>
            <span className={`shrink-0 text-xs font-medium uppercase tracking-wide ${r.state === 'done' ? 'text-[var(--green-text,#1fb257)]' : r.state === 'now' ? 'text-[var(--blue-text)]' : ''}`}>{t(`camAi.live.state.${r.state}`)}</span>
          </li>
        ))}
      </ol>
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--text-secondary)]">
        <span><span className="inline-block w-3 h-0.5 align-middle bg-[#facc15] mr-1" aria-hidden />{t('camAi.live.rough')}</span>
        <span><span className="inline-block w-3 h-0.5 align-middle bg-[#22d3ee] mr-1" aria-hidden />{t('camAi.live.finish')}</span>
        <span><span className="inline-block w-3 h-0.5 align-middle bg-[#ef4444] mr-1" aria-hidden />{t('camAi.live.drill')}</span>
      </p>
    </div>
  );
}

/** Measuring the model in CAM AI's view: on or off, what a click picks, what it measured (the simulator's words). */
function MeasurePanel({ on, onToggle, mode, onMode, measured, inSim = false }: { on: boolean; onToggle: () => void; mode: MeasureMode; onMode: (m: MeasureMode) => void; measured: Measurement; inSim?: boolean }) {
  const { t } = useTranslation(['remapper']);
  const mm = (x: number) => x.toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (
    <div className={`absolute right-3 z-10 flex flex-col-reverse items-end gap-2 ${inSim ? 'bottom-[132px]' : 'bottom-3'}`}>
      {!inSim && <button
        type="button"
        onClick={onToggle}
        aria-pressed={on}
        title={t('toolpath.measureHelp')}
        className={`inline-flex items-center gap-1.5 rounded-full border px-3 h-8 text-xs font-semibold ${on ? 'border-[#22d3ee] bg-[#22d3ee] text-[#062a33]' : 'border-[var(--border-subtle)] bg-[var(--bg-panel)]/90 text-[var(--text-secondary)]'}`}
      >
        <Ruler size={14} aria-hidden /> {t('toolpath.measure')}
      </button>}
      {on && (
        <div className="w-64 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-panel)]/95 p-3 space-y-2 text-xs" aria-live="polite">
          <div className="inline-flex rounded-full border border-[var(--border-subtle)] p-0.5" role="radiogroup" aria-label={t('toolpath.measure')}>
            {(['faces', 'points', 'diameter', 'axes'] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => onMode(m)} className={`px-2 h-6 rounded-full text-xs font-bold ${mode === m ? 'bg-[#22d3ee] text-[#062a33]' : 'text-[var(--text-secondary)]'}`}>
                {t(`toolpath.measureMode.${m}`)}
              </button>
            ))}
          </div>
          {measured?.kind === 'hole' ? (
            <div>
              <div className="font-mono text-base font-bold text-[var(--text-primary)]">Ø {mm(measured.mm)} mm</div>
              <div className="text-[var(--text-secondary)]">{t('toolpath.measureHoleDepth', { depth: mm(measured.depth) })}</div>
            </div>
          ) : measured?.kind === 'distance' ? (
            <div>
              <div className="font-mono text-base font-bold text-[var(--text-primary)]">{mm(measured.mm)} mm</div>
              {measured.d && <div className="font-mono text-xs text-[var(--text-secondary)]">ΔX {mm(Math.abs(measured.d[0]))} · ΔY {mm(Math.abs(measured.d[1]))} · ΔZ {mm(Math.abs(measured.d[2]))}</div>}
            </div>
          ) : measured?.kind === 'none' || measured?.kind === 'notParallel' ? (
            <div className="text-[var(--orange-text)]">{t(measured.kind === 'none' ? 'toolpath.measureNone' : 'toolpath.measureNotParallel')}</div>
          ) : null}
          <p className="text-[var(--text-secondary)]">{measured?.kind === 'picked' || measured?.kind === 'notParallel' ? t('toolpath.measureSecond') : t(`toolpath.measureHint.${mode}`)}</p>
        </div>
      )}
    </div>
  );
}

/** A panel's open or closed, remembered in this browser (a private window: until the page closes). */
function useStoredFlag(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? initial : v === '1';
    } catch {
      return initial;
    }
  });
  const set = (v: boolean) => {
    setOn(v);
    try {
      localStorage.setItem(key, v ? '1' : '0');
    } catch {
      /* private window */
    }
  };
  return [on, set];
}

/** The window's width, as it changes. */
function useWindowWidth() {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return w;
}
