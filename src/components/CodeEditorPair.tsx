import React, { useState, useRef, useMemo, useEffect, lazy, Suspense } from 'react';
import { Copy, Check, Upload, Download, Sparkles, CheckCircle2, ArrowLeftRight, AlertTriangle, RefreshCw, ShieldCheck, ShieldAlert, XCircle, X, Ruler, RotateCw, Gauge, Crosshair, MoveVertical, Flag, Route, ChevronDown, Lock, Box, HardDrive } from 'lucide-react';
import { type SafetyCode, type SafetyReport } from '../lib/safetyCheck';

const ToolpathViewer = lazy(() => import('./ToolpathViewer'));
const ToolpathSoon = lazy(() => import('./ToolpathSoon'));
import { convertFanucToHaas, FanucToHaasResult } from '../lib/fanucToHaasConverter';
import { convertHaasToFanuc, HaasToFanucResult } from '../lib/haasToFanucConverter';
import { applyG53BeforeG52, isWholeProgram } from '../lib/gcodeProcessor';
import { exportBlocked } from '../lib/setups';
import { useT } from '../i18n';
import { useSync } from '../contexts/SyncContext';
import { useAuth } from '../contexts/AuthContext';
import { useCollisionCheck } from '../lib/useCollisionCheck';
import { locale } from '../i18n/format';
import { scopedKey } from '../lib/instance';
import { MODEL_MAX_BYTES } from '../lib/modelLimits';
import type { TurnFix } from '../lib/fixTurns';
import type { Mat3 } from '../lib/orient';
import { translateGcodeComments } from '../lib/gcodeTranslate';
import { currentRegion } from '../lib/instance';

/** The comment at the end of a line (or the line), to find a line again after N numbers changed. */
const lastComment = (l: string) => l.match(/\(([^)]*)\)\s*$/)?.[1].trim() ?? l.trim();

/** Height of one output line and the pane's top padding (p-5), in px: rows are fixed so only the visible ones are drawn. */
const OUT_ROW = 25;
const OUT_PAD = 20;
/** Rows drawn above and below the visible ones, so a fast scroll does not show blank space. */
const OUT_OVERSCAN = 40;

/** The range of rows [first, last) visible in a scrolling element (plus the overscan). */
function useVisibleRows(ref: React.RefObject<HTMLElement | null>, count: number): { first: number; last: number } {
  const [view, setView] = useState({ top: 0, height: 1000 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      setView((v) => (v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight }));
    };
    const later = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    el.addEventListener('scroll', later, { passive: true });
    const resize = new ResizeObserver(later);
    resize.observe(el);
    read();
    return () => {
      el.removeEventListener('scroll', later);
      resize.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ref]);
  const first = Math.max(0, Math.floor((view.top - OUT_PAD) / OUT_ROW) - OUT_OVERSCAN);
  const last = Math.min(count, Math.ceil((view.top - OUT_PAD + view.height) / OUT_ROW) + OUT_OVERSCAN);
  return { first: Math.min(first, count), last: Math.max(last, Math.min(first, count)) };
}

/**
 * Puts corrected M0 comments into a program: each line found by its comment (`key` turns a line's
 * comment into the form the changes were found in), all or nothing (null when one is missing).
 */
function rewriteComments(code: string, changes: TurnFix['changes'], key: (comment: string) => string, to: (comment: string) => string): string | null {
  const ls = code.split('\n');
  for (const c of changes) {
    const want = lastComment(c.from);
    const i = ls.findIndex((l) => key(lastComment(l)) === want);
    const now = c.to.match(/\(([^)]*)\)\s*$/);
    if (i < 0 || !now) return null;
    ls[i] = ls[i].replace(/\([^)]*\)\s*$/, `(${to(now[1])})`);
  }
  return ls.join('\n');
}

// "NEW" on the toolpath button until it is first opened on this PC.
const TOOLPATH_SEEN = scopedKey('cnc-toolpath-seen');
const toolpathSeen = () => {
  try {
    return localStorage.getItem(TOOLPATH_SEEN) === '1';
  } catch {
    return true;
  }
};

interface CodeEditorPairProps {
  inputLabel: string;
  outputLabel: string;
  sourceCode: string;
  setSourceCode: (code: string) => void;
  outputCode: string;
  fileName?: string;
  setFileName?: (name: string) => void;
  onExport?: () => void;
  onLoadSample?: () => void;
  onLoadHaasSample?: () => void;
  /** The output was generated from a different program/machine than what is shown now. */
  isOutputStale?: boolean;
  onReanalyze?: () => void;
  /** Safety check of the output; errors ask for a confirmation before export. */
  safety?: SafetyReport | null;
  /** Called when someone exports although the safety check found red problems. */
  onSafetyOverride?: (errors: number) => void;
  /** Brand of the target machine (rapid speed and tool change time of the toolpath estimate). */
  machineBrand?: string;
  /** FANUC-2 runs HAAS code: the HAAS → FANUC button leaves the program as it is. */
  haasOnly?: boolean;
  /** The output with corrected comments (and the source they come from): it stays the current output. */
  onOutputCorrected?: (output: string, source: string) => void;
}

/** Symbol and short code of each check: readable without knowing the app's language. */
const CHECK_SYMBOL: Record<SafetyCode, { icon: React.ComponentType<{ size?: number; className?: string; style?: React.CSSProperties }>; code: string }> = {
  noOffset: { icon: Ruler, code: 'G43' },
  offsetMismatch: { icon: Ruler, code: 'H≠T' },
  spindleOff: { icon: RotateCw, code: 'M3' },
  noFeed: { icon: Gauge, code: 'F' },
  noWorkOffset: { icon: Crosshair, code: 'G54' },
  toolTooShort: { icon: MoveVertical, code: 'L' },
  noProgramEnd: { icon: Flag, code: 'M30' },
  tooBig: { icon: HardDrive, code: 'KB' },
};
const LEVEL_COLOR = { error: 'var(--rose-500)', warning: 'var(--orange-500)', ok: 'var(--green-500)' } as const;

/**
 * The safety check above the output: one slim row of symbols (green = OK, orange = look,
 * red = fix); the problems, and only those, are listed under it in words.
 */
function SafetyPanel({
  report,
  confirming,
  onExportAnyway,
  onCancel,
  onGoToLine,
}: {
  report: SafetyReport;
  confirming: boolean;
  onExportAnyway: () => void;
  onCancel: () => void;
  onGoToLine: (line: number) => void;
}) {
  const { t } = useT('remapper');
  const statusOf = (c: SafetyCode): { level: keyof typeof LEVEL_COLOR; line: number | null } => {
    const related = report.findings.filter((f) => f.code === c || (c === 'noOffset' && f.code === 'offsetMismatch'));
    const worst = related.find((f) => f.level === 'error') ?? related[0];
    return { level: worst ? worst.level : 'ok', line: worst?.line ?? null };
  };
  const clean = report.findings.length === 0;
  // The list of problems is a pull tab: folded unless opened, or when an export is being confirmed.
  const [open, setOpen] = useState(false);
  const showList = !clean && (open || confirming);

  return (
    <div className="border-b border-[var(--border-subtle)] px-4 py-2 space-y-1.5">
      <div className="flex items-center gap-1.5 flex-wrap">
        {clean ? (
          <ShieldCheck size={16} className="text-[var(--green-500)] shrink-0" aria-label={t('safety.title')} />
        ) : (
          <ShieldAlert size={16} style={{ color: report.errors ? LEVEL_COLOR.error : LEVEL_COLOR.warning }} className="shrink-0" aria-label={t('safety.title')} />
        )}
        {report.ran.map((c) => {
          const { level, line } = statusOf(c);
          const { icon: Icon, code } = CHECK_SYMBOL[c];
          const color = LEVEL_COLOR[level];
          const Mark = level === 'ok' ? Check : level === 'error' ? X : AlertTriangle;
          return (
            <button
              key={c}
              type="button"
              title={t(`safety.checks.${c}`)}
              aria-label={`${t(`safety.checks.${c}`)}: ${level === 'ok' ? 'OK' : level}`}
              disabled={line === null}
              onClick={() => line !== null && onGoToLine(line)}
              className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-mono font-bold border disabled:cursor-default"
              style={{ color, borderColor: `color-mix(in srgb, ${color} 35%, transparent)`, background: `color-mix(in srgb, ${color} ${level === 'ok' ? 6 : 14}%, transparent)` }}
            >
              <Icon size={11} />
              {code}
              <Mark size={10} strokeWidth={3} />
            </button>
          );
        })}
        {clean && <span className="text-xs text-[var(--green-500)] font-semibold ml-1 truncate">{t('safety.allClear', { count: report.ran.length })}</span>}
        {!clean && !confirming && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[rgba(var(--ov),0.06)]"
          >
            <span className="font-mono">{report.findings.length}</span>
            {open ? t('safety.hide') : t('safety.show')}
            <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
        )}
      </div>

      {showList && (
        <div className="space-y-1">
          {report.findings.map((f, i) => {
            const color = LEVEL_COLOR[f.level];
            const { icon: Icon, code } = CHECK_SYMBOL[f.code];
            return (
              <button
                key={i}
                type="button"
                disabled={f.line === null}
                onClick={() => f.line !== null && onGoToLine(f.line)}
                className="w-full flex items-center gap-2 text-left text-xs py-0.5 enabled:hover:brightness-125 disabled:cursor-default"
              >
                {f.level === 'error' ? <XCircle size={14} style={{ color }} className="shrink-0" /> : <AlertTriangle size={14} style={{ color }} className="shrink-0" />}
                <span className="inline-flex items-center gap-1 font-mono font-bold text-xs shrink-0" style={{ color }}>
                  <Icon size={11} />
                  {code}
                </span>
                <span className="flex-1 min-w-0 truncate text-[var(--text-primary)]" title={t(`safety.msg.${f.code}` as 'safety.msg.noOffset', f.params as { t: string })}>
                  {t(`safety.msg.${f.code}` as 'safety.msg.noOffset', f.params as { t: string })}
                </span>
                {f.params.n || f.params.line ? (
                  <span className="font-mono text-xs text-[var(--text-tertiary)] shrink-0">{f.params.n || `#${f.params.line}`}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}

      {confirming && (
        <div className="flex items-center gap-2 pt-1">
          <XCircle size={15} className="text-[var(--rose-500)] shrink-0" />
          <span className="flex-1 min-w-0 text-xs font-semibold text-[var(--text-primary)] truncate" title={t('safety.confirmText')}>
            {t('safety.confirmTitle')}
          </span>
          <button type="button" onClick={onCancel} className="btn-secondary text-xs py-1 px-2.5 shrink-0">{t('safety.cancel')}</button>
          <button type="button" onClick={onExportAnyway} className="btn-danger text-xs py-1 px-2.5 font-semibold shrink-0">
            <Download size={12} />
            <span>{t('safety.exportAnyway')}</span>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Marks which output lines are new or modified. Lines are matched by content
 * (not by position), so inserting or deleting a line no longer turns every
 * following line green.
 */
function computeChangedLines(sourceLines: string[], outputLines: string[]): boolean[] {
  // Compare without the N number: a line that was only renumbered (because a G53 Y0 was
  // inserted above it) is not a real change and should not be highlighted.
  const key = (l: string) => l.replace(/^\s*N\d+\s*/i, '').trim();
  const available = new Map<string, number>();
  for (const l of sourceLines) available.set(key(l), (available.get(key(l)) ?? 0) + 1);
  return outputLines.map(raw => {
    const l = key(raw);
    const n = available.get(l) ?? 0;
    if (n > 0) {
      available.set(l, n - 1);
      return false;
    }
    return true;
  });
}

export default function CodeEditorPair({ 
  inputLabel, 
  outputLabel, 
  sourceCode: rawSourceCode, 
  setSourceCode, 
  outputCode: rawOutputCode,
  fileName,
  setFileName,
  onExport,
  onLoadSample,
  onLoadHaasSample,
  isOutputStale = false,
  onReanalyze,
  safety = null,
  onSafetyOverride,
  machineBrand,
  haasOnly = false,
  onOutputCorrected,
}: CodeEditorPairProps) {
  const [showToolpath, setShowToolpath] = useState(false);
  const [showSoon, setShowSoon] = useState(false);
  // Off for a country until a master admin switches it on, and in beta: only admins and the
  // people an admin picked. Otherwise the button shows a padlock and says why.
  const { user } = useAuth();
  const countryOn = useSync().features.toolpath;
  const toolpathOn = countryOn && (user?.role === 'ADMIN' || !!user?.toolpathBeta);
  const [toolpathNew, setToolpathNew] = useState(() => !toolpathSeen());
  const { t } = useT('remapper');
  const [confirmingExport, setConfirmingExport] = useState(false);
  const outputScrollRef = useRef<HTMLDivElement>(null);
  const [isCopied, setIsCopied] = useState(false);
  const [hasImported, setHasImported] = useState(false);
  const [conversionNotification, setConversionNotification] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The part's 3D PDF or STL (for the toolpath to check the program against): kept while the page is open.
  const [model, setModel] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  // Comments the 3D model corrected (as the output writes them), highlighted in the output; and the
  // turns it found for a program, which the collision check then uses for that program.
  const [correctedNotes, setCorrectedNotes] = useState<Set<string>>(new Set());
  const [foundTurns, setFoundTurns] = useState<{ code: string; orients: Mat3[] } | null>(null);
  useEffect(() => {
    setCorrectedNotes(new Set());
    setFoundTurns(null);
  }, [model]);
  const [askModel, setAskModel] = useState(false);
  const modelInputRef = useRef<HTMLInputElement>(null);
  const pickModel = async (file: File) => {
    setAskModel(false);
    if (file.size > MODEL_MAX_BYTES) {
      setConversionNotification(t('toolpath.model.errors.tooBig'));
      return;
    }
    setModel({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
  };

  // Guarantee sourceCode and outputCode are always pristine strings
  const getSafeString = (val: unknown, fallback = ''): string => {
    if (typeof val === 'string') return val;
    if (val && typeof (val as Record<string, unknown>).code === 'string') {
      return (val as Record<string, unknown>).code as string;
    }
    if (val && typeof (val as Record<string, unknown>).value === 'string') {
      return (val as Record<string, unknown>).value as string;
    }
    return val ? String(val) : fallback;
  };

  const sourceCode: string = getSafeString(rawSourceCode);
  const outputCode: string = getSafeString(rawOutputCode);

  // Collisions (tools and holders into the jaws, holders into the part): with the toolpath viewer
  // (beta), the output is checked and cannot be copied or downloaded until there is none.
  const [checkAgain, setCheckAgain] = useState(0);
  const checkedCode = toolpathOn && outputCode && !isOutputStale ? outputCode : '';
  const collisions = useCollisionCheck(checkedCode, machineBrand, checkAgain, foundTurns?.code === checkedCode ? foundTurns.orients : undefined);
  // A tool into a cale is a warning (move the cale), not a reason to stop the export.
  const blocking = useMemo(() => collisions.hits.filter((h) => h.what !== 'cale' && h.what !== 'spacer'), [collisions.hits]);
  const caleHits = useMemo(() => collisions.hits.filter((h) => h.what === 'cale'), [collisions.hits]);
  const isAdmin = user?.role === 'ADMIN';
  const blocked = exportBlocked(collisions.hits, collisions.checking, isAdmin);
  const holderHits = useMemo(() => collisions.hits.filter((h) => h.what === 'holderPart'), [collisions.hits]);
  // A collision in the code shown: the toolpath button turns red and opens where it happens.
  const hitShown = toolpathOn && !!outputCode && !isOutputStale && blocking.length > 0;
  const caleShown = toolpathOn && !!outputCode && !isOutputStale && !hitShown && caleHits.length > 0;

  const copyToClipboard = async () => {
    if (!outputCode || isOutputStale || blocked) return;
    const { lines: processedLines } = applyG53BeforeG52(outputCode.split('\n'));
    try {
      await navigator.clipboard.writeText(processedLines.join('\n'));
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch {
      alert(t('editor.copyFailed'));
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedText = e.clipboardData.getData('text');
    // Another whole program: the imported file's name (and the full O number HAAS -> FANUC takes from
    // it) is not this program's any more.
    if (setFileName && isWholeProgram(pastedText)) setFileName('program.nc');
    if (pastedText) {
      const lines = pastedText.split('\n');
      const { lines: processedLines, addedCount } = applyG53BeforeG52(lines);
      if (addedCount > 0) {
        e.preventDefault();
        const target = e.currentTarget;
        const start = target.selectionStart;
        const end = target.selectionEnd;
        const val = target.value;
        const insertion = processedLines.join('\n');
        const nextVal = val.substring(0, start) + insertion + val.substring(end);
        setSourceCode(nextVal);
        setConversionNotification(t('editor.g53Placed', { count: addedCount }));
        setTimeout(() => setConversionNotification(null), 6000);
        setTimeout(() => {
          target.selectionStart = target.selectionEnd = start + insertion.length;
        }, 0);
      }
    }
  };

  const handleBlur = () => {
    if (!sourceCode.trim()) return;
    const lines = sourceCode.split('\n');
    const { lines: processedLines, addedCount } = applyG53BeforeG52(lines);
    if (addedCount > 0) {
      setSourceCode(processedLines.join('\n'));
      setConversionNotification(t('editor.g53Placed', { count: addedCount }));
      setTimeout(() => setConversionNotification(null), 6000);
    }
  };

  const handleExportClick = (confirmed = false) => {
    if (!outputCode || isOutputStale || blocked) return;
    // Red safety findings: show them and ask before exporting.
    if (!confirmed && safety && safety.errors > 0) {
      setConfirmingExport(true);
      return;
    }
    setConfirmingExport(false);
    if (sourceCode.trim()) {
      const { lines: processedSource, addedCount } = applyG53BeforeG52(sourceCode.split('\n'));
      if (addedCount > 0) {
        setSourceCode(processedSource.join('\n'));
      }
    }
    if (onExport) onExport();
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    if (setFileName) setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result;
      if (typeof text === 'string') {
        const fileLines = text.split('\n');
        const { lines: processedLines, addedCount } = applyG53BeforeG52(fileLines);
        setSourceCode(processedLines.join('\n'));
        setHasImported(true);
        // A new program: ask for its 3D model (the one given before was for another program).
        setModel(null);
        setAskModel(true);
        if (addedCount > 0) {
          setConversionNotification(t('editor.g53Placed', { count: addedCount }));
          setTimeout(() => setConversionNotification(null), 6000);
        } else {
          setConversionNotification(null);
        }
      }
    };
    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // The corrected M0 comments (found by the toolpath with the 3D model), put into the program as
  // soon as they are found: into the program on the left and into the output (which stays current),
  // highlighted there. The viewer worked on the output when there was one, else on the program.
  const useFix = (changes: TurnFix['changes']): boolean => {
    const english = currentRegion().gcodeComments === 'en';
    const shown = (c: string) => (english ? lastComment(translateGcodeComments(`(${c})`)) : c);
    const same = (c: string) => c;
    const fromOutput = !!outputCode && !isOutputStale;
    const source = rewriteComments(sourceCode, changes, fromOutput ? shown : same, same);
    const output = fromOutput ? rewriteComments(outputCode, changes, same, shown) : null;
    if (!source || (fromOutput && !output)) return false;
    setSourceCode(source);
    if (output) onOutputCorrected?.(output, source);
    setCorrectedNotes(new Set(changes.map((c) => shown(lastComment(c.to)))));
    return true;
  };

  const handleSwitchFanucToHaas = () => {
    if (!sourceCode.trim()) return;
    
    const { lines: processedSource, addedCount: sourceAdded } = applyG53BeforeG52(sourceCode.split('\n'));
    const cleanSource = processedSource.join('\n');
    if (sourceAdded > 0) {
      setSourceCode(cleanSource);
    }

    const result: FanucToHaasResult = convertFanucToHaas(cleanSource, fileName || 'program.txt');
    
    setSourceCode(result.haasCode);
    // The file keeps its imported name: the export is named exactly like the imported program.

    setHasImported(false);
    
    const details: string[] = [];
    if (result.stats.securityLinesReplaced > 0) details.push(t('convert.securityLineUpdated'));
    if (result.stats.trailingZFixed > 0) details.push(t('convert.trailingZAdded', { count: result.stats.trailingZFixed }));
    if (result.stats.m98LinesDeleted > 0) details.push(t('convert.m98ToTableOut', { count: result.stats.m98LinesDeleted }));
    if (result.stats.g43Converted > 0) details.push(t('convert.g43Converted', { count: result.stats.g43Converted }));
    if (result.stats.g53Y0Added > 0) details.push(t('convert.g53Added', { count: result.stats.g53Y0Added }));

    const summaryText = details.length > 0
      ? t('convert.toHaas', { details: details.join(', ') })
      : t('convert.toHaasPlain');

    setConversionNotification(summaryText);
    setTimeout(() => setConversionNotification(null), 6000);
  };

  const handleSwitchHaasToFanuc = () => {
    if (!sourceCode.trim()) return;
    if (haasOnly) {
      setConversionNotification(t('convert.fanuc2KeepsHaas'));
      setTimeout(() => setConversionNotification(null), 6000);
      return;
    }
    
    const { lines: processedSource, addedCount: sourceAdded } = applyG53BeforeG52(sourceCode.split('\n'));
    const cleanSource = processedSource.join('\n');
    if (sourceAdded > 0) {
      setSourceCode(cleanSource);
    }

    const result: HaasToFanucResult = convertHaasToFanuc(cleanSource, fileName || 'fanuc_program.nc');
    
    setSourceCode(result.fanucCode);
    // The file keeps its imported name: the export is named exactly like the imported program.

    setHasImported(false);
    
    const details: string[] = [];
    if (result.stats.securityLinesReplaced > 0) details.push(t('convert.securityLines'));
    if (result.stats.g43Converted > 0) details.push(t('convert.g43ToFanuc', { count: result.stats.g43Converted }));
    if (result.stats.coolantMerged > 0) details.push(t('convert.coolantMerged', { count: result.stats.coolantMerged }));
    if (result.stats.m98LinesDeleted > 0) details.push(t('convert.m98Removed', { count: result.stats.m98LinesDeleted }));
    if (result.stats.g53Y0Added > 0) details.push(t('convert.g53Added', { count: result.stats.g53Y0Added }));
    if (result.stats.percentWrapped) details.push(t('convert.percentWrapped'));

    const summaryText = details.length > 0
      ? t('convert.toFanuc', { details: details.join(', ') })
      : t('convert.toFanucPlain');

    setConversionNotification(summaryText);
    setTimeout(() => setConversionNotification(null), 6000);
  };

  const outputLines = useMemo(() => outputCode.split('\n'), [outputCode]);
  // Only the lines in view are drawn (a 20 000-line program was 20 000 rows redrawn on each key).
  const outputView = useVisibleRows(outputScrollRef, outputLines.length);
  const outputWidth = useMemo(() => outputLines.reduce((m, l) => Math.max(m, l.length), 0), [outputLines]);
  const goToOutputLine = (line: number) => {
    const el = outputScrollRef.current;
    if (el) el.scrollTo({ top: OUT_PAD + line * OUT_ROW - el.clientHeight / 2 + OUT_ROW / 2, behavior: 'smooth' });
  };
  // Lines the safety check flagged (errors win over warnings on the same line).
  const safetyLines = useMemo(() => {
    const map = new Map<number, 'error' | 'warning'>();
    for (const f of safety?.findings ?? []) if (f.line !== null && map.get(f.line) !== 'error') map.set(f.line, f.level);
    return map;
  }, [safety]);
  useEffect(() => setConfirmingExport(false), [outputCode]);
  // Ctrl+S (Cmd+S on a Mac) downloads the program instead of saving the web page.
  useEffect(() => {
    if (!onExport) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's') return;
      e.preventDefault();
      handleExportClick();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const changedLines = useMemo(
    () => (outputCode ? computeChangedLines(sourceCode.split('\n'), outputLines) : []),
    // Recomputed only when a new output is generated, not on every keystroke in the source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [outputLines]
  );

  return (
    <div className="flex-1 flex flex-col space-y-4 min-h-[540px]">
      {/* Conversion Banner when file is imported */}
      {hasImported && (
        <div className="glass-panel p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 animate-in fade-in duration-200">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-[var(--blue-500)]/20 border border-[var(--blue-500)]/40 flex items-center justify-center text-[var(--blue-text)] shrink-0">
              <Sparkles size={16} />
            </div>
            <div>
              <span className="text-xs font-semibold text-[var(--text-primary)]">
                {t('editor.importedPrefix')} <code className="font-mono text-[var(--blue-text)] font-bold">{fileName}</code> {t('editor.importedSuffix')}
              </span>
              <p className="text-xs text-[var(--text-secondary)]">
                {t('editor.importedHint')}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={handleSwitchFanucToHaas}
              className="btn-primary text-xs min-h-11 px-3.5"
            >
              <Sparkles size={13} />
              <span>{t('editor.fromFanucToHaas')}</span>
            </button>
            <button
              onClick={handleSwitchHaasToFanuc}
              className="btn-warning text-xs min-h-11 px-3.5"
            >
              <ArrowLeftRight size={13} />
              <span>{t('editor.fromHaasToFanuc')}</span>
            </button>
          </div>
        </div>
      )}

      {conversionNotification && (
        <div className="badge-positive toast-bottom justify-between gap-3 py-2.5 pl-4 pr-2 text-xs font-medium" role="status">
          <div className="flex items-center gap-2">
            <CheckCircle2 size={16} className="text-[var(--green-500)] shrink-0" />
            <span>{conversionNotification}</span>
          </div>
          <button
            onClick={() => setConversionNotification(null)}
            aria-label={t('common:actions.dismiss')}
            className="btn-icon w-8 h-8 shrink-0"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* 2-Pane Editor Layout: Left = Source Code, Right = Processed Code */}
      {/* Fixed height: each pane scrolls on its own, so only the lines in view are drawn. */}
      <div className="flex-1 lg:flex-none grid grid-cols-1 lg:grid-cols-2 lg:grid-rows-[minmax(0,1fr)] gap-4 lg:h-[calc(100dvh-11rem)] lg:min-h-[560px]">
        {/* Source Code Pane (Aurora Card) */}
        <div className="aurora-card p-0 flex flex-col overflow-hidden min-h-[460px] h-[75dvh] lg:h-auto">
          {/* Pane Header */}
          <div className="px-5 py-3.5 border-b border-[var(--border-subtle)] bg-[rgba(var(--surface),0.6)] flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2.5">
              <span className="section-label text-[var(--text-primary)]">
                {inputLabel}
              </span>
              {fileName && (
                <span className="badge-neutral text-xs py-0.5 px-2 font-mono max-w-[140px] truncate" title={fileName}>
                  {fileName}
                </span>
              )}
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              {sourceCode.trim().length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <button
                    onClick={handleSwitchFanucToHaas}
                    title={t('editor.fanucToHaasTitle')}
                    className="btn-secondary text-xs min-h-11 px-3.5"
                  >
                    <Sparkles size={12} className="text-[var(--blue-text)]" />
                    <span>FANUC &rarr; HAAS</span>
                  </button>
                  <button
                    onClick={handleSwitchHaasToFanuc}
                    title={t('editor.haasToFanucTitle')}
                    className="btn-secondary text-xs min-h-11 px-3.5"
                  >
                    <ArrowLeftRight size={12} className="text-[var(--orange-text)]" />
                    <span>HAAS &rarr; FANUC</span>
                  </button>
                </div>
              )}

              {!sourceCode.trim() && (
                <div className="flex items-center gap-1.5">
                  {onLoadSample && (
                    <button
                      onClick={onLoadSample}
                      className="btn-secondary text-xs min-h-11 px-3.5"
                      title={t('editor.sampleFanucTitle')}
                    >
                      {t('editor.sampleFanuc')}
                    </button>
                  )}
                  {onLoadHaasSample && (
                    <button
                      onClick={onLoadHaasSample}
                      className="btn-secondary text-xs min-h-11 px-3.5"
                      title={t('editor.sampleHaasTitle')}
                    >
                      {t('editor.sampleHaas')}
                    </button>
                  )}
                </div>
              )}

              {setFileName && (
                <>
                  <input 
                    type="file" 
                    ref={fileInputRef} 
                    onChange={handleFileUpload} 
                    className="hidden" 
                  />
                  <button 
                    onClick={() => fileInputRef.current?.click()}
                    className="btn-secondary text-xs min-h-11 px-3.5"
                  >
                    <Upload size={13} />
                    <span>{t('common:actions.import')}</span>
                  </button>
                </>
              )}
              {toolpathOn && (
                <>
                  <input
                    type="file"
                    ref={modelInputRef}
                    accept=".pdf,.stl"
                    hidden
                    aria-label={t('toolpath.model.add')}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      if (f) void pickModel(f);
                    }}
                  />
                  {model ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-[#8fb3e0]/50 bg-[#8fb3e0]/10 pl-2.5 pr-0.5 h-7 text-xs font-semibold text-[var(--text-primary)] max-w-[14rem]">
                      <Box size={12} className="text-[#8fb3e0] shrink-0" />
                      <span className="truncate">{model.name}</span>
                      <button onClick={() => setModel(null)} className="btn-icon w-6 h-6 shrink-0" title={t('toolpath.model.remove')} aria-label={t('toolpath.model.remove')}>
                        <X size={11} />
                      </button>
                    </span>
                  ) : (
                    <button onClick={() => modelInputRef.current?.click()} className="btn-secondary text-xs min-h-11 px-3.5" title={t('toolpath.model.addHelp')}>
                      <Box size={13} />
                      <span>{t('toolpath.model.add')}</span>
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          {toolpathOn && askModel && !model && sourceCode.trim() && (
            <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] bg-[#8fb3e0]/10 px-5 py-2 text-xs text-[var(--text-primary)]" role="status">
              <Box size={14} className="text-[#8fb3e0] shrink-0" />
              <span className="flex-1 min-w-[12rem]">{t('toolpath.model.ask')}</span>
              <button onClick={() => modelInputRef.current?.click()} className="btn-primary text-xs py-1 px-2.5">
                <Upload size={12} />
                {t('toolpath.model.add')}
              </button>
              <button onClick={() => setAskModel(false)} className="btn-secondary text-xs min-h-11 px-3.5">
                {t('toolpath.model.skip')}
              </button>
            </div>
          )}
          {/* Textarea */}
          <textarea
            value={sourceCode}
            onChange={e => {
              setSourceCode(e.target.value);
              setConversionNotification(null);
            }}
            onPaste={handlePaste}
            onBlur={handleBlur}
            spellCheck={false}
            className="flex-1 min-h-0 w-full resize-none p-5 font-mono text-[13px] leading-relaxed text-[var(--text-primary)] bg-[var(--bg-input)] focus:outline-none overflow-auto border-none selection:bg-[var(--blue-500)]/30"
            placeholder={t('editor.sourcePlaceholder')}
          />
        </div>

        {/* Processed Code Pane (Aurora Card) */}
        <div className="aurora-card p-0 flex flex-col overflow-hidden min-h-[460px] h-[75dvh] lg:h-auto">
          {/* Pane Header */}
          <div className="px-5 py-3.5 border-b border-[var(--border-subtle)] bg-[rgba(var(--surface),0.6)] flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <span className="section-label text-[var(--text-primary)]">
                {outputLabel}
              </span>
              {outputCode && (
                <span className="w-2 h-2 rounded-full bg-[var(--green-500)] shadow-[0_0_6px_var(--green-glow)] shrink-0" />
              )}
            </div>
            
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  // Switched off for the country: show what is coming. Beta-locked people only get the title.
                  if (!toolpathOn) {
                    if (!countryOn) setShowSoon(true);
                    return;
                  }
                  setShowToolpath(true);
                  setToolpathNew(false);
                  try {
                    localStorage.setItem(TOOLPATH_SEEN, '1');
                  } catch {
                    /* the tag just stays */
                  }
                }}
                disabled={toolpathOn && !outputCode && !sourceCode.trim()}
                aria-disabled={(countryOn && !toolpathOn) || undefined}
                aria-haspopup={countryOn ? undefined : 'dialog'}
                className={`btn-secondary text-xs py-1 px-2.5 ${hitShown ? '!border-[#ff4d4d] !text-[#ff6b6b] !bg-[#ff4d4d]/10 shadow-[0_0_14px_rgba(255,77,77,0.35)]' : caleShown ? '!border-[#f5b942] !text-[var(--orange-text)] !bg-[#f5b942]/10' : ''} ${toolpathOn ? '' : countryOn ? 'opacity-60 cursor-not-allowed' : 'opacity-60'}`}
                title={hitShown ? t('toolpath.openHitTitle') : caleShown ? t('toolpath.openCaleTitle') : toolpathOn ? t('toolpath.openTitle') : t(countryOn ? 'toolpath.betaLocked' : 'toolpath.locked')}
              >
                {hitShown || caleShown ? <ShieldAlert size={13} /> : toolpathOn ? <Route size={13} /> : <Lock size={13} />}
                <span className="hidden sm:inline">{t('toolpath.open')}</span>
                {toolpathOn && toolpathNew && <span className="rounded-full bg-[var(--accent-primary)] px-1.5 py-px text-[10px] font-bold leading-4 text-white">{t('toolpath.new')}</span>}
                {!toolpathOn && <span className="sr-only">{t(countryOn ? 'toolpath.betaLocked' : 'toolpath.locked')}</span>}
              </button>
              <button 
                onClick={copyToClipboard}
                disabled={!outputCode || isOutputStale || blocked}
                className="btn-secondary text-xs min-h-11 px-3.5"
                title={blocked && outputCode ? t('editor.collisionBlockedTitle') : t('editor.copyTitle')}
              >
                {isCopied ? <Check size={13} className="text-[var(--green-500)]" /> : <Copy size={13} />}
                <span>{isCopied ? t('editor.copied') : t('editor.copy')}</span>
              </button>
              {onExport && (
                <button 
                  onClick={() => handleExportClick()}
                  disabled={!outputCode || isOutputStale || blocked}
                  title={blocked && outputCode ? t('editor.collisionBlockedTitle') : `${t('editor.extractTitle')} (Ctrl+S)`}
                  className="btn-warning text-xs min-h-11 px-3.5 font-semibold"
                >
                  <Download size={13} />
                  <span>{t('editor.extract')}</span>
                </button>
              )}
            </div>
          </div>

          {outputCode && !isOutputStale && (collisions.checking || blocking.length > 0) && (
            <div
              role={collisions.checking ? 'status' : 'alert'}
              className={`px-5 py-2.5 border-b border-[var(--border-subtle)] text-xs flex flex-wrap items-center gap-x-3 gap-y-1.5 ${collisions.checking ? 'text-[var(--text-secondary)]' : 'bg-[var(--rose-500)]/10'}`}
            >
              {collisions.checking ? (
                <span className="inline-flex items-center gap-2">
                  <RefreshCw size={13} className="animate-spin motion-reduce:animate-none" /> {t('editor.collisionChecking')}
                </span>
              ) : (
                <>
                  <span className="inline-flex items-center gap-2 font-semibold text-[var(--rose-text)]">
                    <ShieldAlert size={14} /> {t(isAdmin ? 'editor.collisionAdmin' : 'editor.collisionBlocked', { count: blocking.length })}
                  </span>
                  <span className="flex flex-wrap gap-1.5">
                    {blocking.slice(0, 6).map((h, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => goToOutputLine(h.line)}
                        className="badge-danger font-mono hover:underline"
                      >
                        #{h.line + 1} · {t(h.what === 'holder' ? 'toolpath.holderJawHit' : h.what === 'holderPart' ? 'toolpath.holderPartHit' : 'toolpath.jawHit', { t: h.tool ?? '?', mm: (Math.round(h.depth * 10) / 10).toLocaleString(locale()) })}
                      </button>
                    ))}
                  </span>
                  <button type="button" onClick={() => setShowToolpath(true)} className="btn-secondary text-xs py-1 px-2.5 ml-auto">
                    <Route size={13} /> {t('editor.collisionOpen')}
                  </button>
                </>
              )}
            </div>
          )}
          {outputCode && !isOutputStale && !collisions.checking && collisions.rejects.length > 0 && (
            <div role="status" className="px-5 py-2.5 border-b border-[var(--border-subtle)] text-xs space-y-2 bg-[rgba(224,138,77,0.12)]">
              {collisions.rejects.map((b, i) => {
                const all = outputLines;
                const from = Math.max(0, b.line - 2);
                return (
                  <div key={i} className="space-y-1.5">
                    <button
                      type="button"
                      onClick={() => goToOutputLine(b.line)}
                      className="inline-flex items-center gap-2 font-semibold text-[var(--orange-text)] hover:underline text-left"
                    >
                      <ShieldAlert size={14} className="shrink-0" />{' '}
                      {b.kind === 'cale'
                        ? t('editor.reject.cale', { mm: b.mm.toLocaleString(locale()), line: b.line + 1 })
                        : t('editor.reject.size', { want: b.want.toLocaleString(locale()), axis: b.axis, found: b.found.toLocaleString(locale()), line: b.line + 1 })}
                    </button>
                    <pre className="font-mono text-[11px] leading-5 rounded-md bg-[var(--bg-base)] border border-[var(--border-subtle)] px-2 py-1 overflow-x-auto">
                      {all.slice(from, b.line + 3).map((l, j) => (
                        <div key={j} className={from + j === b.line ? 'text-[var(--orange-text)] font-semibold' : 'text-[var(--text-secondary)]'}>
                          {String(from + j + 1).padStart(5, ' ')}  {l}
                        </div>
                      ))}
                    </pre>
                  </div>
                );
              })}
            </div>
          )}
          {outputCode && !isOutputStale && !collisions.checking && caleHits.length > 0 && (
            <div role="status" className="px-5 py-2.5 border-b border-[var(--border-subtle)] text-xs flex flex-wrap items-center gap-x-3 gap-y-1.5 bg-[rgba(224,138,77,0.12)]">
              <span className="inline-flex items-center gap-2 font-semibold text-[var(--orange-text)]">
                <ShieldAlert size={14} /> {t('editor.caleWarning', { count: caleHits.length })}
              </span>
              <span className="flex flex-wrap gap-1.5">
                {caleHits.slice(0, 6).map((h, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => goToOutputLine(h.line)}
                    className="badge-warning font-mono hover:underline"
                  >
                    #{h.line + 1} · {t('toolpath.caleHit', { t: h.tool ?? '?', mm: (Math.round(h.depth * 10) / 10).toLocaleString(locale()) })}
                  </button>
                ))}
              </span>
              <button type="button" onClick={() => setShowToolpath(true)} className="btn-secondary text-xs py-1 px-2.5 ml-auto">
                <Route size={13} /> {t('editor.collisionOpen')}
              </button>
            </div>
          )}
          {safety && outputCode && !isOutputStale && (
            <SafetyPanel
              report={safety}
              confirming={confirmingExport}
              onExportAnyway={() => {
                onSafetyOverride?.(safety.errors);
                handleExportClick(true);
              }}
              onCancel={() => setConfirmingExport(false)}
              onGoToLine={goToOutputLine}
            />
          )}

          {isOutputStale && outputCode && (
            <div className="px-4 py-2.5 border-b border-[var(--orange-500)]/30 bg-[rgba(224,138,77,0.12)] flex items-center justify-between gap-3 text-xs">
              <span className="flex items-center gap-2 text-[var(--orange-text)] font-semibold">
                <AlertTriangle size={14} className="shrink-0" />
                {t('editor.stale')}
              </span>
              {onReanalyze && (
                <button onClick={onReanalyze} className="btn-warning text-xs py-1 px-2.5 shrink-0">
                  <RefreshCw size={12} />
                  <span>{t('editor.reanalyze')}</span>
                </button>
              )}
            </div>
          )}

          {/* Code Viewer */}
          <div ref={outputScrollRef} tabIndex={0} role="region" aria-label={outputLabel} className={`flex-1 min-h-0 w-full p-5 overflow-auto bg-[var(--bg-input)] focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)] -outline-offset-2 ${isOutputStale ? 'opacity-50' : ''}`}>
            {!outputCode ? (
              <div className="h-full flex items-center justify-center text-center p-6">
                <div className="max-w-xs space-y-2">
                  <div className="w-12 h-12 mx-auto rounded-full bg-[rgba(var(--ov),0.04)] border border-[var(--border-subtle)] flex items-center justify-center text-[var(--text-tertiary)]">
                    <Sparkles size={20} />
                  </div>
                  <p className="text-sm font-semibold text-[var(--text-primary)]">
                    {t('editor.emptyTitle')}
                  </p>
                  <p className="text-xs text-[var(--text-tertiary)] leading-relaxed">
                    {t('editor.emptyText')}
                  </p>
                </div>
              </div>
            ) : (
              <pre key="out" className="reveal-in font-mono text-[13px] text-[var(--text-primary)] w-full" style={{ minWidth: `calc(${outputWidth}ch + 1rem)` }}>
                <div style={{ height: outputView.first * OUT_ROW }} aria-hidden />
                {outputLines.slice(outputView.first, outputView.last).map((line, k) => {
                  const i = outputView.first + k;
                  const isChanged = changedLines[i];
                  const isApprox = line.includes('(APPROX-REMAP:');
                  
                  let lineClass = 'text-[var(--text-primary)]';
                  const flagged = safetyLines.get(i);
                  if (flagged) {
                    lineClass = flagged === 'error'
                      ? 'bg-[var(--rose-500)]/15 text-[var(--rose-text)] -mx-1 px-1 rounded font-semibold border-l-2 border-[var(--rose-500)]'
                      : 'bg-[var(--orange-500)]/15 text-[var(--orange-text)] -mx-1 px-1 rounded font-semibold border-l-2 border-[var(--orange-500)] border-dashed';
                  } else if (correctedNotes.size && correctedNotes.has(lastComment(line))) {
                    lineClass = 'bg-[#8b5cf6]/20 text-[#c4b5fd] -mx-1 px-1 rounded font-semibold border-l-2 border-[#8b5cf6]';
                  } else if (isApprox) {
                    lineClass = 'bg-[var(--orange-500)]/20 text-[var(--orange-text)] -mx-1 px-1 rounded font-semibold border-l-2 border-[var(--orange-500)]';
                  } else if (isChanged) {
                    lineClass = 'bg-[var(--green-500)]/15 text-[var(--green-text)] -mx-1 px-1 rounded font-semibold border-l-2 border-[var(--green-500)]';
                  }
                  
                  return (
                    <div key={i} data-line={i} className={`whitespace-pre ${lineClass}`} style={{ height: OUT_ROW, lineHeight: `${OUT_ROW}px` }} title={correctedNotes.has(lastComment(line)) ? t('toolpath.model.correctedLine') : undefined}>
                      {line || ' '}
                    </div>
                  );
                })}
                <div style={{ height: (outputLines.length - outputView.last) * OUT_ROW }} aria-hidden />
              </pre>
            )}
          </div>
        </div>
      </div>
      {showSoon && (
        <Suspense fallback={null}>
          <ToolpathSoon onClose={() => setShowSoon(false)} />
        </Suspense>
      )}
      {showToolpath && (
        <Suspense fallback={null}>
          <ToolpathViewer
            code={outputCode && !isOutputStale ? outputCode : sourceCode}
            title={fileName || 'program'}
            brand={machineBrand}
            onClose={() => {
              setShowToolpath(false);
              // The jaw height may have changed in the viewer.
              setCheckAgain((n) => n + 1);
            }}
            holderHits={outputCode && !isOutputStale ? holderHits : undefined}
            focusHit={hitShown || caleShown}
            initialModel={model}
            onModelChange={setModel}
            onUseFix={useFix}
            onTurnsFound={(code, orients) => setFoundTurns(orients ? { code, orients } : null)}
          />
        </Suspense>
      )}
    </div>
  );
}
