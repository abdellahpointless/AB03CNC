import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Upload, X } from 'lucide-react';
import { motion } from 'motion/react';
import { api, errorMessage } from '../lib/api';
import { iosBackdrop, iosSurface } from '../lib/motion';
import { useSync } from '../contexts/SyncContext';
import { downloadToolTemplate, readToolWorkbook } from '../lib/toolExcel';
import { CATEGORY_HELP, EXAMPLE_ROWS, IMPORT_MACHINES, TEMPLATE_HEADERS, type ParseResult } from '../lib/toolExcelParse';
import { MATERIALS } from '../types';

type Mode = 'update' | 'replace';

/** Admin dialog: shows the expected Excel layout, reads a filled-in file, previews it, then imports. */
export function ToolExcelImport({ onClose }: { onClose: () => void }) {
  const { toolbox, refreshNow } = useSync();
  const inputRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [fileName, setFileName] = useState('');
  const [mode, setMode] = useState<Mode>('update');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ machine: string; added: number; updated: number; total: number }[] | null>(null);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    setBusy(true);
    setFileName(file.name);
    try {
      setParsed(await readToolWorkbook(file));
    } catch (e) {
      setError(errorMessage(e, 'Could not read the file'));
    } finally {
      setBusy(false);
    }
  };

  const machines = parsed ? Object.keys(parsed.byMachine) : [];
  const canImport = !!parsed && machines.length > 0 && parsed.errors.length === 0;

  const preview = machines.map((m) => {
    const current = toolbox[m as keyof typeof toolbox] || [];
    const existing = new Set(current.map((t) => t.number));
    const list = parsed!.byMachine[m];
    const updated = list.filter((t) => existing.has(t.number)).length;
    return { machine: m, total: list.length, updated, added: list.length - updated, removed: mode === 'replace' ? current.length : 0 };
  });

  const run = async () => {
    if (!canImport || busy) return;
    if (mode === 'replace' && !confirm(`Replace the whole tool list of ${machines.join(', ')} with the file content? Tools that are not in the file will be removed.`)) return;
    setBusy(true);
    setError('');
    try {
      const res = await api<{ summary: { machine: string; added: number; updated: number; total: number }[] }>('/admin/import/tools-excel', {
        method: 'POST',
        body: { machines: parsed!.byMachine, mode },
      });
      await refreshNow();
      setDone(res.summary);
    } catch (e) {
      setError(errorMessage(e, 'Import failed'));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <motion.div
      className="fixed inset-0 modal-backdrop flex items-center justify-center p-4 z-[99999]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      {...iosBackdrop}
    >
      <motion.div className="glass-modal max-w-3xl w-full p-6 max-h-[92vh] overflow-y-auto" {...iosSurface}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-[var(--text-primary)] flex items-center gap-2">
            <FileSpreadsheet size={16} className="text-[var(--green-500)]" /> Import machines and tools from Excel
          </h3>
          <button onClick={onClose} className="btn-icon w-7 h-7" title="Close"><X size={14} /></button>
        </div>

        {done ? (
          <div className="space-y-4">
            <div className="badge-positive w-full py-2 px-3 text-xs flex items-center gap-2"><CheckCircle2 size={14} /> Import finished.</div>
            <ul className="text-xs text-[var(--text-secondary)] space-y-1">
              {done.map((d) => (
                <li key={d.machine}><strong className="text-[var(--text-primary)]">{d.machine}</strong>: {d.added} added, {d.updated} updated ({d.total} tools in the file)</li>
              ))}
            </ul>
            <button onClick={onClose} className="btn-primary w-full text-xs py-2">Close</button>
          </div>
        ) : (
          <div className="space-y-5">
            {/* 1. Format guide */}
            <section className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <h4 className="section-label text-[var(--text-primary)]">1. Fill in the Excel file</h4>
                <button type="button" onClick={() => downloadToolTemplate()} className="btn-secondary text-xs py-1.5 px-3">
                  <Download size={13} /> <span>Download the template (.xlsx)</span>
                </button>
              </div>
              <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                One row per tool, the first row holds the column names. The template already has drop-down lists and an
                <strong className="text-[var(--text-primary)]"> Instructions</strong> sheet. Example:
              </p>
              <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--border-subtle)]">
                <table className="w-full text-[11px] border-collapse font-mono">
                  <thead>
                    <tr className="bg-[var(--blue-500)]/15 text-[var(--text-primary)]">
                      {TEMPLATE_HEADERS.map((h) => <th key={h} className="p-2 text-left whitespace-nowrap font-bold">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {EXAMPLE_ROWS.map((r, i) => (
                      <tr key={i} className="border-t border-[var(--border-subtle)] text-[var(--text-secondary)]">
                        {r.map((c, j) => <td key={j} className="p-2 whitespace-nowrap">{String(c)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="text-[11px] text-[var(--text-tertiary)] space-y-0.5 leading-relaxed list-disc pl-4">
                <li><strong className="text-[var(--text-secondary)]">Machine</strong>: {IMPORT_MACHINES.join(', ')}</li>
                <li><strong className="text-[var(--text-secondary)]">T-Number</strong>: the number in the G-code (T12 &rarr; 12), unique per machine. <strong className="text-[var(--text-secondary)]">Pocket</strong>, Description, Diameter, Length and Materials are optional.</li>
                <li><strong className="text-[var(--text-secondary)]">Category</strong>: {Object.entries(CATEGORY_HELP).map(([k, v]) => `${k} (${v})`).join(', ')}</li>
                <li><strong className="text-[var(--text-secondary)]">Materials</strong> (comma separated, empty = general tool): {MATERIALS.join(', ')}</li>
                <li>An empty slot is a row with Machine, T-Number and Category <code>empty</code>.</li>
              </ul>
            </section>

            {/* 2. Upload */}
            <section className="space-y-2">
              <h4 className="section-label text-[var(--text-primary)]">2. Choose your file</h4>
              <input ref={inputRef} type="file" accept=".xlsx" className="hidden" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer.files?.[0]); }}
                disabled={busy}
                className="no-glass w-full border-2 border-dashed border-[var(--border-subtle)] hover:border-[var(--blue-500)]/60 rounded-[var(--radius-md)] py-5 flex flex-col items-center gap-1.5 text-xs text-[var(--text-secondary)] transition-colors"
              >
                <Upload size={18} className="text-[var(--blue-500)]" />
                <span>{fileName ? fileName : 'Click to choose an .xlsx file, or drop it here'}</span>
              </button>
            </section>

            {/* 3. Preview */}
            {parsed && (
              <section className="space-y-3">
                <h4 className="section-label text-[var(--text-primary)]">3. Check and import</h4>
                {parsed.errors.length > 0 && (
                  <div className="p-3 rounded-[var(--radius-md)] bg-[var(--rose-500)]/10 border border-[var(--rose-500)]/30 text-xs space-y-1">
                    <div className="flex items-center gap-2 font-semibold text-[var(--rose-500)]"><AlertTriangle size={14} /> {parsed.errors.length} problem{parsed.errors.length > 1 ? 's' : ''} to fix in the file (nothing was imported)</div>
                    <ul className="text-[var(--text-secondary)] space-y-0.5 max-h-40 overflow-y-auto">
                      {parsed.errors.slice(0, 30).map((er, i) => <li key={i}>{er.row > 0 ? `Row ${er.row}: ` : ''}{er.message}</li>)}
                      {parsed.errors.length > 30 && <li>...and {parsed.errors.length - 30} more.</li>}
                    </ul>
                  </div>
                )}
                {machines.length > 0 && (
                  <>
                    <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--border-subtle)]">
                      <table className="w-full text-xs border-collapse">
                        <thead><tr className="bg-[rgba(var(--ov),0.04)] text-left"><th className="p-2">Machine</th><th className="p-2">Tools in file</th><th className="p-2">New</th><th className="p-2">Replace existing T-number</th>{mode === 'replace' && <th className="p-2">Removed</th>}</tr></thead>
                        <tbody>
                          {preview.map((p) => (
                            <tr key={p.machine} className="border-t border-[var(--border-subtle)]">
                              <td className="p-2 font-semibold text-[var(--text-primary)]">{p.machine}</td>
                              <td className="p-2">{p.total}</td>
                              <td className="p-2 text-[var(--green-500)]">{mode === 'replace' ? p.total : p.added}</td>
                              <td className="p-2">{mode === 'replace' ? '-' : p.updated}</td>
                              {mode === 'replace' && <td className="p-2 text-[var(--rose-500)]">{p.removed}</td>}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="grid sm:grid-cols-2 gap-2 text-xs">
                      {([
                        ['update', 'Add / update', 'Tools with the same T-number are replaced, all other tools stay.'],
                        ['replace', 'Replace', "Each machine in the file gets exactly the file's tools; its old tools are removed."],
                      ] as [Mode, string, string][]).map(([key, title, text]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setMode(key)}
                          className={`no-glass text-left p-3 rounded-[var(--radius-md)] border transition-colors ${mode === key ? 'border-[var(--blue-500)] bg-[var(--blue-500)]/10' : 'border-[var(--border-subtle)] hover:border-[var(--blue-500)]/40'}`}
                        >
                          <div className="font-semibold text-[var(--text-primary)]">{title}{key === 'update' && ' (recommended)'}</div>
                          <div className="text-[var(--text-tertiary)] mt-0.5">{text}</div>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </section>
            )}

            {error && <div className="badge-danger w-full py-1.5 px-3 text-xs">{error}</div>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className="btn-secondary text-xs py-2 px-4">Cancel</button>
              <button type="button" onClick={run} disabled={!canImport || busy} className="btn-primary text-xs py-2 px-5">
                {busy ? 'Working...' : canImport ? `Import ${parsed!.tools.length} tool${parsed!.tools.length > 1 ? 's' : ''}` : 'Import'}
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </motion.div>,
    document.body,
  );
}
