import React, { useState, useRef, useMemo } from 'react';
import { Copy, Check, Upload, Download, Sparkles, CheckCircle2, ArrowLeftRight, AlertTriangle, RefreshCw } from 'lucide-react';
import { convertFanucToHaas, FanucToHaasResult } from '../lib/fanucToHaasConverter';
import { convertHaasToFanuc, HaasToFanucResult } from '../lib/haasToFanucConverter';
import { applyG53BeforeG52 } from '../lib/gcodeProcessor';

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
}

/**
 * Marks which output lines are new or modified. Lines are matched by content
 * (not by position), so inserting or deleting a line no longer turns every
 * following line green.
 */
function computeChangedLines(sourceLines: string[], outputLines: string[]): boolean[] {
  const available = new Map<string, number>();
  for (const l of sourceLines) available.set(l, (available.get(l) ?? 0) + 1);
  return outputLines.map(l => {
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
  onReanalyze
}: CodeEditorPairProps) {
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
      alert('Copy failed: the browser blocked clipboard access. Use "Extract Code" instead.');
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
        setConversionNotification(`Detected G52 on paste: Automatically placed ${addedCount} G53 Y0 before G52`);
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
      setConversionNotification(`Detected G52: Automatically placed ${addedCount} G53 Y0 before G52`);
      setTimeout(() => setConversionNotification(null), 6000);
    }
  };

  const handleExportClick = () => {
    if (!outputCode || isOutputStale) return;
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
          setConversionNotification(`Detected G52: Automatically placed ${addedCount} G53 Y0 before G52`);
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
    if (result.stats.n100n110Deleted > 0) details.push('N100/N110 deleted');
    if (result.stats.securityLinesReplaced > 0) details.push('Security line updated');
    if (result.stats.trailingZFixed > 0) details.push(`${result.stats.trailingZFixed} trailing Z. added`);
    if (result.stats.m98LinesDeleted > 0) details.push(`${result.stats.m98LinesDeleted} M98 P7999 removed`);
    if (result.stats.g43Converted > 0) details.push(`${result.stats.g43Converted} G43 converted`);
    if (result.stats.g53Y0Added > 0) details.push(`${result.stats.g53Y0Added} G53 Y0 before G52 added`);

    const summaryText = details.length > 0 
      ? `Switched to HAAS: ${details.join(', ')}`
      : 'Switched code to HAAS dialect';

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
    if (result.stats.securityLinesReplaced > 0) details.push('Security lines -> G0 G53 G49 Z0 G94 M95');
    if (result.stats.g43Converted > 0) details.push(`${result.stats.g43Converted} G43 -> H#513 D#513 M254`);
    if (result.stats.coolantMerged > 0) details.push(`${result.stats.coolantMerged} M08 merged`);
    if (result.stats.feedRatesFixed > 0) details.push(`${result.stats.feedRatesFixed} feedrates fixed`);
    if (result.stats.trailingZFixed > 0) details.push(`${result.stats.trailingZFixed} trailing Z fixed`);
    if (result.stats.m98LinesDeleted > 0) details.push(`${result.stats.m98LinesDeleted} M98 P7999 removed`);
    if (result.stats.g53Y0Added > 0) details.push(`${result.stats.g53Y0Added} G53 Y0 before G52 added`);
    if (result.stats.percentWrapped) details.push('% wrapped');

    const summaryText = details.length > 0 
      ? `Switched to FANUC: ${details.join(', ')}`
      : 'Switched code from HAAS to FANUC dialect';

    setConversionNotification(summaryText);
    setTimeout(() => setConversionNotification(null), 6000);
  };

  const outputLines = useMemo(() => outputCode.split('\n'), [outputCode]);
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
                File <code className="font-mono text-[var(--blue-500)] font-bold">{fileName}</code> imported.
              </span>
              <p className="text-[11px] text-[var(--text-secondary)]">
                Select your target machine dialect or switch between standards:
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={handleSwitchFanucToHaas}
              className="btn-primary text-xs py-1.5 px-3"
            >
              <Sparkles size={13} />
              <span>from FANUC to HAAS</span>
            </button>
            <button
              onClick={handleSwitchHaasToFanuc}
              className="btn-warning text-xs py-1.5 px-3"
            >
              <ArrowLeftRight size={13} />
              <span>from HAAS to FANUC</span>
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
          <div className="px-5 py-3.5 border-b border-[var(--border-subtle)] bg-[rgba(15,20,30,0.6)] flex items-center justify-between flex-wrap gap-2">
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
                    title="Convert source code from FANUC dialect to HAAS dialect"
                    className="btn-secondary text-xs py-1 px-2.5"
                  >
                    <Sparkles size={12} className="text-[var(--blue-500)]" />
                    <span>FANUC &rarr; HAAS</span>
                  </button>
                  <button
                    onClick={handleSwitchHaasToFanuc}
                    title="Convert source code from HAAS dialect to FANUC dialect"
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
                      title="Load sample FANUC program"
                    >
                      Sample FANUC
                    </button>
                  )}
                  {onLoadHaasSample && (
                    <button
                      onClick={onLoadHaasSample}
                      className="btn-secondary text-xs py-1 px-2.5"
                      title="Load sample HAAS program"
                    >
                      Sample HAAS
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
                    <span>Import</span>
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
            placeholder="Paste or import raw CNC G-code program here..."
          />
        </div>

        {/* Processed Code Pane (Aurora Card) */}
        <div className="aurora-card p-0 flex flex-col overflow-hidden min-h-[460px]">
          {/* Pane Header */}
          <div className="px-5 py-3.5 border-b border-[var(--border-subtle)] bg-[rgba(15,20,30,0.6)] flex items-center justify-between flex-wrap gap-2">
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
                title="Copy remapped G-code to clipboard"
              >
                {isCopied ? <Check size={13} className="text-[var(--green-500)]" /> : <Copy size={13} />}
                <span>{isCopied ? 'Copied' : 'Copy'}</span>
              </button>
              {onExport && (
                <button 
                  onClick={handleExportClick}
                  disabled={!outputCode || isOutputStale}
                  title="Extract and download the processed G-code file"
                  className="btn-warning text-xs py-1.5 px-3 font-semibold"
                >
                  <Download size={13} />
                  <span>Extract Code</span>
                </button>
              )}
            </div>
          </div>

          {isOutputStale && outputCode && (
            <div className="px-4 py-2.5 border-b border-[var(--orange-500)]/30 bg-[rgba(224,138,77,0.12)] flex items-center justify-between gap-3 text-xs">
              <span className="flex items-center gap-2 text-[var(--orange-500)] font-semibold">
                <AlertTriangle size={14} className="shrink-0" />
                The program or machine changed after this code was generated.
              </span>
              {onReanalyze && (
                <button onClick={onReanalyze} className="btn-warning text-xs py-1 px-2.5 shrink-0">
                  <RefreshCw size={12} />
                  <span>Re-analyze</span>
                </button>
              )}
            </div>
          )}

          {/* Code Viewer */}
          <div className={`flex-1 w-full p-5 overflow-auto bg-[var(--bg-input)] ${isOutputStale ? 'opacity-50' : ''}`}>
            {!outputCode ? (
              <div className="h-full flex items-center justify-center text-center p-6">
                <div className="max-w-xs space-y-2">
                  <div className="w-12 h-12 mx-auto rounded-full bg-[rgba(255,255,255,0.04)] border border-[var(--border-subtle)] flex items-center justify-center text-[var(--text-tertiary)]">
                    <Sparkles size={20} />
                  </div>
                  <p className="text-sm font-semibold text-[var(--text-primary)]">
                    No remapped code generated yet
                  </p>
                  <p className="text-xs text-[var(--text-tertiary)] leading-relaxed">
                    Click &quot;Analyze &amp; Remap&quot; above to resolve tools against the target machine toolbox.
                  </p>
                </div>
              </div>
            ) : (
              <pre className="font-mono text-[13px] leading-relaxed text-[var(--text-primary)] w-full">
                {outputLines.map((line, i) => {
                  const isChanged = changedLines[i];
                  const isApprox = line.includes('(APPROX-REMAP:');
                  
                  let lineClass = 'text-[var(--text-primary)]';
                  if (isApprox) {
                    lineClass = 'bg-[var(--orange-500)]/20 text-[var(--orange-500)] -mx-1 px-1 rounded font-semibold border-l-2 border-[var(--orange-500)]';
                  } else if (isChanged) {
                    lineClass = 'bg-[var(--green-500)]/15 text-[var(--green-500)] -mx-1 px-1 rounded font-semibold border-l-2 border-[var(--green-500)]';
                  }
                  
                  return (
                    <div key={i} className={`py-0.5 ${lineClass}`}>
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
