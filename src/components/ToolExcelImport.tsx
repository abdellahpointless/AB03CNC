import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Upload, X } from 'lucide-react';
import { motion } from 'motion/react';
import { api, errorMessage } from '../lib/api';
import { iosBackdrop, iosSurface } from '../lib/motion';
import { useSync } from '../contexts/SyncContext';
import { downloadToolTemplate, readToolWorkbook } from '../lib/toolExcel';
import { CATEGORY_HELP, NEW_MACHINE_PREFIX, categoryName, exampleRows, templateHeaders, type ParseResult } from '../lib/toolExcelParse';
import { MACHINE_BRANDS } from '../regions';
import { MATERIALS } from '../types';
import { useT } from '../i18n';

type Mode = 'update' | 'replace';

/** Admin dialog: shows the expected Excel layout, reads a filled-in file, previews it, then imports. */
export function ToolExcelImport({ onClose }: { onClose: () => void }) {
  const { t } = useT('tools');
  const { toolbox, refreshNow, toolMachines, reloadMachines } = useSync();
  const examples = exampleRows(toolMachines);
  const headers = templateHeaders();
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
      setParsed(await readToolWorkbook(file, toolMachines));
    } catch (e) {
      setError(errorMessage(e, t('import.readFailed')));
    } finally {
      setBusy(false);
    }
  };

  const machines = parsed ? Object.keys(parsed.byMachine) : [];
  const canImport = !!parsed && machines.length > 0 && parsed.errors.length === 0;

  const preview = machines.map((m) => {
    const isNew = m.startsWith(NEW_MACHINE_PREFIX);
    const current = isNew ? [] : toolbox[m] || [];
    const existing = new Set(current.map((t) => t.number));
    const list = parsed!.byMachine[m];
    const updated = list.filter((t) => existing.has(t.number)).length;
    const name = isNew ? m.slice(NEW_MACHINE_PREFIX.length) : toolMachines.find((x) => x.id === m)?.name ?? m;
    return { machine: m, name, isNew, total: list.length, updated, added: list.length - updated, removed: mode === 'replace' ? current.length : 0 };
  });

  const run = async () => {
    if (!canImport || busy) return;
    const replaced = preview.filter((p) => !p.isNew).map((p) => p.name);
    if (mode === 'replace' && replaced.length && !confirm(t('import.confirmReplace', { machines: replaced.join(', ') }))) return;
    setBusy(true);
    setError('');
    try {
      // 1. Create the machines that do not exist yet, 2. import every tool.
      const ids: Record<string, string> = {};
      for (const nm of parsed!.newMachines) {
        const res = await api<{ id: string }>('/fleet', { method: 'POST', body: { name: nm.name, brand: nm.brand, model: nm.model, hasTools: true } });
        ids[NEW_MACHINE_PREFIX + nm.name] = res.id;
      }
      if (parsed!.newMachines.length) await reloadMachines();
      const body: Record<string, unknown> = {};
      for (const [key, list] of Object.entries(parsed!.byMachine)) body[ids[key] ?? key] = list;
      const res = await api<{ summary: { machine: string; added: number; updated: number; total: number }[] }>('/admin/import/tools-excel', {
        method: 'POST',
        body: { machines: body, mode },
      });
      await refreshNow();
      const nameOf = (id: string) => toolMachines.find((x) => x.id === id)?.name ?? parsed!.newMachines.find((n) => ids[NEW_MACHINE_PREFIX + n.name] === id)?.name ?? id;
      setDone(res.summary.map((r) => ({ ...r, machine: nameOf(r.machine) })));
    } catch (e) {
      setError(errorMessage(e, t('import.failed')));
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
      <motion.div className="glass-modal max-w-3xl w-full p-6 max-h-[92vh] overflow-y-auto" {...iosSurface} role="dialog" aria-modal="true" aria-label={t('import.title')}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-[var(--text-primary)] flex items-center gap-2">
            <FileSpreadsheet size={16} className="text-[var(--green-500)]" /> {t('import.title')}
          </h3>
          <button onClick={onClose} className="btn-icon w-7 h-7" title={t('common:actions.close')}><X size={14} /></button>
        </div>

        {done ? (
          <div className="space-y-4">
            <div className="badge-positive w-full py-2 px-3 text-xs flex items-center gap-2"><CheckCircle2 size={14} /> {t('import.finished')}</div>
            <ul className="text-xs text-[var(--text-secondary)] space-y-1">
              {done.map((d) => (
                <li key={d.machine}><strong className="text-[var(--text-primary)]">{d.machine}</strong>: {t('import.doneLine', { added: d.added, updated: d.updated, count: d.total })}</li>
              ))}
            </ul>
            <button onClick={onClose} className="btn-primary w-full text-xs py-2">{t('common:actions.close')}</button>
          </div>
        ) : (
          <div className="space-y-5">
            {/* 1. Format guide */}
            <section className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <h4 className="section-label text-[var(--text-primary)]">{t('import.step1')}</h4>
                <button type="button" onClick={() => downloadToolTemplate(toolMachines)} className="btn-secondary text-xs py-1.5 px-3">
                  <Download size={13} /> <span>{t('import.downloadTemplate')}</span>
                </button>
              </div>
              <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                {t('import.introBefore')}
                <strong className="text-[var(--text-primary)]"> {t('excel.sheetInstructions')}</strong>{t('import.introAfter')}
              </p>
              <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--border-subtle)]">
                <table className="w-full text-xs border-collapse font-mono">
                  <thead>
                    <tr className="bg-[var(--blue-500)]/15 text-[var(--text-primary)]">
                      {headers.map((h) => <th key={h} className="p-2 text-left whitespace-nowrap font-bold">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {examples.map((r, i) => (
                      <tr key={i} className="border-t border-[var(--border-subtle)] text-[var(--text-secondary)]">
                        {r.map((c, j) => <td key={j} className="p-2 whitespace-nowrap">{String(c)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="text-xs text-[var(--text-tertiary)] space-y-0.5 leading-relaxed list-disc pl-4">
                <li>
                  <strong className="text-[var(--text-secondary)]">{t('columns.machine')}</strong>:{' '}
                  {toolMachines.length ? toolMachines.map((m) => m.name).join(', ') : t('import.guide.noMachines')}{t('import.guide.machineNewBefore')}
                  <strong className="text-[var(--text-secondary)]">{t('columns.brand')}</strong>{t('import.guide.machineNewAfter', { brands: MACHINE_BRANDS.join(', ') })}
                </li>
                <li><strong className="text-[var(--text-secondary)]">{t('columns.number')}</strong>{t('import.guide.numberText')}<strong className="text-[var(--text-secondary)]">{t('columns.pocket')}</strong>{t('import.guide.optionalText')}</li>
                <li><strong className="text-[var(--text-secondary)]">{t('columns.category')}</strong>: {Object.entries(CATEGORY_HELP).map(([k, v]) => `${categoryName(k)} (${v})`).join(', ')}</li>
                <li><strong className="text-[var(--text-secondary)]">{t('columns.materials')}</strong>{t('import.guide.materialsText')}{MATERIALS.join(', ')}</li>
                <li>{t('import.guide.emptyBefore')}<code>{categoryName('empty')}</code>{t('import.guide.emptyAfter')}</li>
              </ul>
            </section>

            {/* 2. Upload */}
            <section className="space-y-2">
              <h4 className="section-label text-[var(--text-primary)]">{t('import.step2')}</h4>
              <input ref={inputRef} type="file" accept=".xlsx" className="hidden" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer.files?.[0]); }}
                disabled={busy}
                className="no-glass w-full border-2 border-dashed border-[var(--border-subtle)] hover:border-[var(--blue-500)]/60 rounded-[var(--radius-md)] py-5 flex flex-col items-center gap-1.5 text-xs text-[var(--text-secondary)] transition-colors"
              >
                <Upload size={18} className="text-[var(--blue-text)]" />
                <span>{fileName ? fileName : t('import.dropHint')}</span>
              </button>
            </section>

            {/* 3. Preview */}
            {parsed && (
              <section className="space-y-3">
                <h4 className="section-label text-[var(--text-primary)]">{t('import.step3')}</h4>
                {parsed.errors.length > 0 && (
                  <div className="p-3 rounded-[var(--radius-md)] bg-[var(--rose-500)]/10 border border-[var(--rose-500)]/30 text-xs space-y-1">
                    <div className="flex items-center gap-2 font-semibold text-[var(--rose-500)]"><AlertTriangle size={14} /> {t('import.problems', { count: parsed.errors.length })}</div>
                    <ul className="text-[var(--text-secondary)] space-y-0.5 max-h-40 overflow-y-auto">
                      {parsed.errors.slice(0, 30).map((er, i) => <li key={i}>{er.row > 0 ? `${t('import.row', { row: er.row })}: ` : ''}{er.message}</li>)}
                      {parsed.errors.length > 30 && <li>{t('import.more', { n: parsed.errors.length - 30 })}</li>}
                    </ul>
                  </div>
                )}
                {machines.length > 0 && (
                  <>
                    <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--border-subtle)]">
                      <table className="w-full text-xs border-collapse">
                        <thead><tr className="bg-[rgba(var(--ov),0.04)] text-left"><th className="p-2">{t('import.table.machine')}</th><th className="p-2">{t('import.table.toolsInFile')}</th><th className="p-2">{t('import.table.new')}</th><th className="p-2">{t('import.table.replaceExisting')}</th>{mode === 'replace' && <th className="p-2">{t('import.table.removed')}</th>}</tr></thead>
                        <tbody>
                          {preview.map((p) => (
                            <tr key={p.machine} className="border-t border-[var(--border-subtle)]">
                              <td className="p-2 font-semibold text-[var(--text-primary)]">
                                {p.name}
                                {p.isNew && <span className="badge-positive text-xs py-0 px-1.5 ml-2">{t('import.table.newMachine')}</span>}
                              </td>
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
                        ['update', t('import.mode.update'), t('import.mode.updateText')],
                        ['replace', t('import.mode.replace'), t('import.mode.replaceText')],
                      ] as [Mode, string, string][]).map(([key, title, text]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setMode(key)}
                          className={`no-glass text-left p-3 rounded-[var(--radius-md)] border transition-colors ${mode === key ? 'border-[var(--blue-500)] bg-[var(--blue-500)]/10' : 'border-[var(--border-subtle)] hover:border-[var(--blue-500)]/40'}`}
                        >
                          <div className="font-semibold text-[var(--text-primary)]">{title}{key === 'update' && t('import.mode.recommended')}</div>
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
              <button type="button" onClick={onClose} className="btn-secondary text-xs py-2 px-4">{t('common:actions.cancel')}</button>
              <button type="button" onClick={run} disabled={!canImport || busy} className="btn-primary text-xs py-2 px-5">
                {busy ? t('common:status.working') : canImport ? t('import.importCount', { count: parsed!.tools.length }) : t('common:actions.import')}
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </motion.div>,
    document.body,
  );
}
