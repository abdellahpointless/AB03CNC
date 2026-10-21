import React, { useState, useRef, useMemo, useEffect } from 'react';
import { Copy, Check, Upload, Download, Sparkles, CheckCircle2, ArrowLeftRight, AlertTriangle, RefreshCw, ShieldCheck, ShieldAlert, ChevronDown, XCircle } from 'lucide-react';
import { SAFETY_CHECKS, type SafetyReport } from '../lib/safetyCheck';
import { convertFanucToHaas, FanucToHaasResult } from '../lib/fanucToHaasConverter';
import { convertHaasToFanuc, HaasToFanucResult } from '../lib/haasToFanucConverter';
import { applyG53BeforeG52 } from '../lib/gcodeProcessor';
import { useT } from '../i18n';

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
}

/** The safety check result above the output: a one-line summary that opens into the list. */
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
  // Open when there is something to read; a clean program stays a single green line.
  const [open, setOpen] = useState(report.findings.length > 0);
  useEffect(() => {
    setOpen(report.findings.length > 0 || confirming);
  }, [report, confirming]);

  const tone = report.errors ? 'rose' : report.warnings ? 'orange' : 'green';
  const color = `var(--${tone}-500)`;
  const summary = report.findings.length
    ? [
        report.errors ? t('safety.errorsCount', { count: report.errors }) : null,
        report.warnings ? t('safety.warningsCount', { count: report.warnings }) : null,
        t('safety.passedCount', { count: report.passed.length }),
      ]
        .filter(Boolean)
        .join(' · ')
    : t('safety.allClear', { count: SAFETY_CHECKS.length });

  return (
    <div className="border-b border-[var(--border-subtle)]" style={{ background: `color-mix(in srgb, ${color} 9%, transparent)` }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full px-4 py-2.5 flex items-center gap-2.5 text-xs text-left"
      >
        {report.errors || report.warnings ? <ShieldAlert size={15} style={{ color }} className="shrink-0" /> : <ShieldCheck size={15} style={{ color }} className="shrink-0" />}
        <span className="font-bold text-[var(--text-primary)]">{t('safety.title')}</span>
        <span className="font-semibold truncate" style={{ color }}>{summary}</span>
        <span className="ml-auto flex items-center gap-1 text-[var(--text-tertiary)] shrink-0">
          {open ? t('safety.hide') : t('safety.show')}
          <ChevronDown size={13} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>
      {open && (
        <div className="px-4 pb-3 space-y-1.5">
          {report.findings.map((f, i) => {
            const fc = f.level === 'error' ? 'var(--rose-500)' : 'var(--orange-500)';
            const where = f.line === null ? t('safety.program') : f.params.n ? t('safety.lineN', { line: f.params.line, n: f.params.n }) : t('safety.line', { line: f.params.line });
            return (
              <button
                key={i}
                type="button"
                disabled={f.line === null}
                onClick={() => f.line !== null && onGoToLine(f.line)}
                className="w-full flex items-start gap-2 text-left text-xs rounded-[var(--radius-sm)] px-2.5 py-1.5 bg-[var(--bg-panel)]/60 border enabled:hover:brightness-110 disabled:cursor-default"
                style={{ borderColor: `color-mix(in srgb, ${fc} 40%, transparent)` }}
              >
                {f.level === 'error' ? <XCircle size={14} style={{ color: fc }} className="shrink-0 mt-px" /> : <AlertTriangle size={14} style={{ color: fc }} className="shrink-0 mt-px" />}
                <span className="flex-1 text-[var(--text-primary)]">{t(`safety.msg.${f.code}` as 'safety.msg.noOffset', f.params as { t: string })}</span>
                <span className="font-mono text-[11px] text-[var(--text-tertiary)] shrink-0">{where}</span>
              </button>
            );
          })}
          {report.passed.map((c) => (
            <div key={c} className="flex items-center gap-2 text-xs px-2.5 py-1 text-[var(--text-secondary)]">
              <CheckCircle2 size={14} className="text-[var(--green-500)] shrink-0" />
              <span>{t(`safety.checks.${c}`)}</span>
            </div>
          ))}
          {confirming && (
            <div className="mt-2 p-3 rounded-[var(--radius-md)] border border-[var(--rose-500)]/40 bg-[var(--rose-500)]/10 flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex-1 text-xs">
                <div className="font-bold text-[var(--text-primary)]">{t('safety.confirmTitle')}</div>
                <div className="text-[var(--text-secondary)] mt-0.5">{t('safety.confirmText')}</div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button type="button" onClick={onCancel} className="btn-secondary text-xs py-1.5 px-3">{t('safety.cancel')}</button>
                <button type="button" onClick={onExportAnyway} className="btn-danger text-xs py-1.5 px-3 font-semibold">
                  <Download size={13} />
                  <span>{t('safety.exportAnyway')}</span>
                </button>
              </div>
            </div>
          )}
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
}: CodeEditorPairProps) {
  const { t } = useT('remapper');
  const [confirmingExport, setConfirmingExport] = useState(false);
  const outputScrollRef = useRef<HTMLDivElement>(null);
  const [isCopied, setIsCopied] = useState(false);
  const [hasImported, setHasImported] = useState(false);
  const [conversionNotification, setConversionNotification] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const copyToClipboard = async () => {
    if (!outputCode || isOutputStale) return;
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
    if (!outputCode || isOutputStale) return;
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

  const handleSwitchFanucToHaas = () => {
    if (!sourceCode.trim()) return;
    
    const { lines: processedSource, addedCount: sourceAdded } = applyG53BeforeG52(sourceCode.split('\n'));
    const cleanSource = processedSource.join('\n');
    if (sourceAdded > 0) {
      setSourceCode(cleanSource);
    }

    const result: FanucToHaasResult = convertFanucToHaas(cleanSource, fileName || 'program.txt');
    
    setSourceCode(result.haasCode);
    if (setFileName && result.haasFilename) {
      setFileName(result.haasFilename);
    }

    setHasImported(false);
    
    const details: string[] = [];
    if (result.stats.n100n110Deleted > 0) details.push(t('convert.n100Deleted'));
    if (result.stats.securityLinesReplaced > 0) details.push(t('convert.securityLineUpdated'));
    if (result.stats.trailingZFixed > 0) details.push(t('convert.trailingZAdded', { count: result.stats.trailingZFixed }));
    if (result.stats.m98LinesDeleted > 0) details.push(t('convert.m98Removed', { count: result.stats.m98LinesDeleted }));
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
    
    const { lines: processedSource, addedCount: sourceAdded } = applyG53BeforeG52(sourceCode.split('\n'));
    const cleanSource = processedSource.join('\n');
    if (sourceAdded > 0) {
      setSourceCode(cleanSource);
    }

    const result: HaasToFanucResult = convertHaasToFanuc(cleanSource, fileName || 'fanuc_program.nc');
    
    setSourceCode(result.fanucCode);
    if (setFileName && result.fanucFilename) {
      setFileName(result.fanucFilename);
    }

    setHasImported(false);
    
    const details: string[] = [];
    if (result.stats.securityLinesReplaced > 0) details.push(t('convert.securityLines'));
    if (result.stats.g43Converted > 0) details.push(t('convert.g43ToFanuc', { count: result.stats.g43Converted }));
    if (result.stats.coolantMerged > 0) details.push(t('convert.coolantMerged', { count: result.stats.coolantMerged }));
    if (result.stats.feedRatesFixed > 0) details.push(t('convert.feedRatesFixed', { count: result.stats.feedRatesFixed }));
    if (result.stats.trailingZFixed > 0) details.push(t('convert.trailingZFixed', { count: result.stats.trailingZFixed }));
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
  // Lines the safety check flagged (errors win over warnings on the same line).
  const safetyLines = useMemo(() => {
    const map = new Map<number, 'error' | 'warning'>();
    for (const f of safety?.findings ?? []) if (f.line !== null && map.get(f.line) !== 'error') map.set(f.line, f.level);
    return map;
  }, [safety]);
  useEffect(() => setConfirmingExport(false), [outputCode]);
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
            <div className="w-8 h-8 rounded-full bg-[var(--blue-500)]/20 border border-[var(--blue-500)]/40 flex items-center justify-center text-[var(--blue-500)] shrink-0">
              <Sparkles size={16} />
            </div>
            <div>
              <span className="text-xs font-semibold text-[var(--text-primary)]">
                {t('editor.importedPrefix')} <code className="font-mono text-[var(--blue-500)] font-bold">{fileName}</code> {t('editor.importedSuffix')}
              </span>
              <p className="text-[11px] text-[var(--text-secondary)]">
                {t('editor.importedHint')}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={handleSwitchFanucToHaas}
              className="btn-primary text-xs py-1.5 px-3"
            >
              <Sparkles size={13} />
              <span>{t('editor.fromFanucToHaas')}</span>
            </button>
            <button
              onClick={handleSwitchHaasToFanuc}
              className="btn-warning text-xs py-1.5 px-3"
            >
              <ArrowLeftRight size={13} />
              <span>{t('editor.fromHaasToFanuc')}</span>
            </button>
          </div>
        </div>
      )}

      {conversionNotification && (
        <div className="badge-positive w-full justify-between py-2 px-4 text-xs font-medium">
          <div className="flex items-center gap-2">
            <CheckCircle2 size={16} className="text-[var(--green-500)] shrink-0" />
            <span>{conversionNotification}</span>
          </div>
          <button 
            onClick={() => setConversionNotification(null)}
            className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] cursor-pointer text-sm"
          >
            ✕
          </button>
        </div>
      )}

      {/* 2-Pane Editor Layout: Left = Source Code, Right = Processed Code */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Source Code Pane (Aurora Card) */}
        <div className="aurora-card p-0 flex flex-col overflow-hidden min-h-[460px]">
          {/* Pane Header */}
          <div className="px-5 py-3.5 border-b border-[var(--border-subtle)] bg-[rgba(var(--surface),0.6)] flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2.5">
              <span className="section-label text-[var(--text-primary)]">
                {inputLabel}
              </span>
              {fileName && (
                <span className="badge-neutral text-[10px] py-0.5 px-2 font-mono max-w-[140px] truncate" title={fileName}>
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
                    className="btn-secondary text-xs py-1 px-2.5"
                  >
                    <Sparkles size={12} className="text-[var(--blue-500)]" />
                    <span>FANUC &rarr; HAAS</span>
                  </button>
                  <button
                    onClick={handleSwitchHaasToFanuc}
                    title={t('editor.haasToFanucTitle')}
                    className="btn-secondary text-xs py-1 px-2.5"
                  >
                    <ArrowLeftRight size={12} className="text-[var(--orange-500)]" />
                    <span>HAAS &rarr; FANUC</span>
                  </button>
                </div>
              )}

              {!sourceCode.trim() && (
                <div className="flex items-center gap-1.5">
                  {onLoadSample && (
                    <button
                      onClick={onLoadSample}
                      className="btn-secondary text-xs py-1 px-2.5"
                      title={t('editor.sampleFanucTitle')}
                    >
                      {t('editor.sampleFanuc')}
                    </button>
                  )}
                  {onLoadHaasSample && (
                    <button
                      onClick={onLoadHaasSample}
                      className="btn-secondary text-xs py-1 px-2.5"
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
                    className="btn-secondary text-xs py-1 px-2.5"
                  >
                    <Upload size={13} />
                    <span>{t('common:actions.import')}</span>
                  </button>
                </>
              )}
            </div>
          </div>

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
            className="flex-1 w-full resize-none p-5 font-mono text-[13px] leading-relaxed text-[var(--text-primary)] bg-[var(--bg-input)] focus:outline-none overflow-auto border-none selection:bg-[var(--blue-500)]/30"
            placeholder={t('editor.sourcePlaceholder')}
          />
        </div>

        {/* Processed Code Pane (Aurora Card) */}
        <div className="aurora-card p-0 flex flex-col overflow-hidden min-h-[460px]">
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
                onClick={copyToClipboard}
                disabled={!outputCode || isOutputStale}
                className="btn-secondary text-xs py-1 px-2.5"
                title={t('editor.copyTitle')}
              >
                {isCopied ? <Check size={13} className="text-[var(--green-500)]" /> : <Copy size={13} />}
                <span>{isCopied ? t('editor.copied') : t('editor.copy')}</span>
              </button>
              {onExport && (
                <button 
                  onClick={() => handleExportClick()}
                  disabled={!outputCode || isOutputStale}
                  title={t('editor.extractTitle')}
                  className="btn-warning text-xs py-1.5 px-3 font-semibold"
                >
                  <Download size={13} />
                  <span>{t('editor.extract')}</span>
                </button>
              )}
            </div>
          </div>

          {safety && outputCode && !isOutputStale && (
            <SafetyPanel
              report={safety}
              confirming={confirmingExport}
              onExportAnyway={() => handleExportClick(true)}
              onCancel={() => setConfirmingExport(false)}
              onGoToLine={(line) => outputScrollRef.current?.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })}
            />
          )}

          {isOutputStale && outputCode && (
            <div className="px-4 py-2.5 border-b border-[var(--orange-500)]/30 bg-[rgba(224,138,77,0.12)] flex items-center justify-between gap-3 text-xs">
              <span className="flex items-center gap-2 text-[var(--orange-500)] font-semibold">
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
          <div ref={outputScrollRef} className={`flex-1 w-full p-5 overflow-auto bg-[var(--bg-input)] ${isOutputStale ? 'opacity-50' : ''}`}>
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
              <pre className="font-mono text-[13px] leading-relaxed text-[var(--text-primary)] w-full">
                {outputLines.map((line, i) => {
                  const isChanged = changedLines[i];
                  const isApprox = line.includes('(APPROX-REMAP:');
                  
                  let lineClass = 'text-[var(--text-primary)]';
                  const flagged = safetyLines.get(i);
                  if (flagged) {
                    lineClass = flagged === 'error'
                      ? 'bg-[var(--rose-500)]/15 text-[var(--rose-500)] -mx-1 px-1 rounded font-semibold border-l-2 border-[var(--rose-500)]'
                      : 'bg-[var(--orange-500)]/15 text-[var(--orange-500)] -mx-1 px-1 rounded font-semibold border-l-2 border-[var(--orange-500)] border-dashed';
                  } else if (isApprox) {
                    lineClass = 'bg-[var(--orange-500)]/20 text-[var(--orange-500)] -mx-1 px-1 rounded font-semibold border-l-2 border-[var(--orange-500)]';
                  } else if (isChanged) {
                    lineClass = 'bg-[var(--green-500)]/15 text-[var(--green-500)] -mx-1 px-1 rounded font-semibold border-l-2 border-[var(--green-500)]';
                  }
                  
                  return (
                    <div key={i} data-line={i} className={`py-0.5 ${lineClass}`}>
                      {line || ' '}
                    </div>
                  );
                })}
              </pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
