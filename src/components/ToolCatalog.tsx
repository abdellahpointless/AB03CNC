import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconAlertTriangle as AlertTriangle, IconCircleCheck as CheckCircle2, IconDatabase as Database, IconUpload as Upload, IconX as X } from '@tabler/icons-react';
import { motion } from 'motion/react';
import { api, errorMessage } from '../lib/api';
import { iosBackdrop, iosSurface } from '../lib/motion';
import { readSheetRows } from '../lib/toolExcel';
import { catalogFromRows, facetOptions, FACETS, matchingTools, type CatalogNote, type CatalogTool, type Facet, type Picks } from '../lib/toolCatalog';
import { fmtDateTime, fmtNumber } from '../i18n/format';
import { useT } from '../i18n';

/*
 * The country's tool database on the page (A032-A034): its dialog (admins load the shop's list there), and the
 * dropdowns that narrow each other until one tool is left, used to add a tool to a machine.
 */

export interface Catalog {
  tools: CatalogTool[];
  updatedAt: number | null;
  updatedBy: string | null;
}

/** The tool database, fetched where the country has one. */
export function useToolCatalog(enabled: boolean) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [failed, setFailed] = useState(false);
  const reload = useCallback(async () => {
    try {
      setCatalog(await api<Catalog>('/tools/catalog'));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);
  return { catalog, failed, setCatalog };
}

const SHOWN = 100;

/** Dropdowns (type, Ø, length, material, ...) that narrow each other in any order, and the tools still left. */
export function ToolCatalogPicker({ tools, picked, onPick, initial }: { tools: CatalogTool[]; picked: CatalogTool | null; onPick: (t: CatalogTool | null) => void; initial?: Picks }) {
  const { t } = useT('tools');
  const [picks, setPicks] = useState<Picks>(initial ?? {});
  const matches = useMemo(() => matchingTools(tools, picks), [tools, picks]);
  // One tool left is the one picked; a pick the dropdowns no longer allow is dropped.
  useEffect(() => {
    if (matches.length === 1 && picked?.code !== matches[0].code) onPick(matches[0]);
    else if (picked && !matches.some((m) => m.code === picked.code)) onPick(null);
  }, [matches, picked, onPick]);

  const mm = (v: number | string) => fmtNumber(Number(v), 2);
  const label = (f: Facet, v: string) => {
    if (f === 'type') {
      const cats = [...new Set(tools.filter((x) => x.type === v).map((x) => x.category))];
      return `${v} · ${cats.map((c) => t(`common:category.${c}`)).join(' / ')}`;
    }
    if (f === 'diameter') return `Ø${mm(v)}`;
    if (f === 'length') return mm(v);
    if (f === 'material') return t(`catalog.material.${v as 'ALU'}`);
    return v;
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {FACETS.map((f) => {
          const options = facetOptions(tools, picks, f);
          if (!options.length && !picks[f]) return null;
          return (
            <label key={f} className="block min-w-0">
              <span className="section-label block mb-1">{t(`catalog.facets.${f}`)}</span>
              <select
                value={picks[f] ?? ''}
                onChange={(e) => setPicks((p) => ({ ...p, [f]: e.target.value || undefined }))}
                className={`aurora-input w-full text-xs min-h-[40px] cursor-pointer ${picks[f] ? 'border-[var(--blue-500)]' : ''}`}
              >
                <option value="">{t('catalog.any', { count: matchingTools(tools, picks, f).length })}</option>
                {options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {label(f, o.value)} ({o.count})
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-[var(--text-secondary)]" aria-live="polite">
          {matches.length ? t('catalog.matches', { count: matches.length }) : t('catalog.noMatch')}
        </span>
        {Object.values(picks).some(Boolean) && (
          <button type="button" onClick={() => setPicks({})} className="btn-secondary text-xs py-1.5 px-3 min-h-[36px]">
            {t('catalog.clear')}
          </button>
        )}
      </div>
      <ul className="max-h-72 overflow-y-auto space-y-1.5 pr-1" aria-label={t('catalog.title')}>
        {matches.slice(0, SHOWN).map((m) => {
          const on = picked?.code === m.code;
          return (
            <li key={m.code}>
              <button
                type="button"
                onClick={() => onPick(m)}
                aria-pressed={on}
                className={`w-full text-left px-3 py-2 min-h-[44px] rounded-[var(--radius-sm)] border transition-colors ${
                  on ? 'border-[var(--blue-500)] bg-[var(--blue-500)]/12' : 'border-[var(--border-subtle)] bg-[var(--bg-card)] hover:bg-[var(--bg-card-hover)]'
                }`}
              >
                <span className="flex flex-wrap items-center justify-between gap-x-3">
                  <span className="font-mono text-xs font-bold text-[var(--text-primary)] break-all">{m.code}</span>
                  <span className="text-xs tabular-nums text-[var(--text-secondary)]">
                    Ø{mm(m.diameter)} · {mm(m.length)} mm{m.extra ? ` · ${m.extra}` : ''}
                  </span>
                </span>
                {m.description && <span className="block text-xs text-[var(--text-secondary)] truncate">{m.description}</span>}
                <span className="flex flex-wrap gap-1 mt-1">
                  {m.materials.map((x) => (
                    <span key={x} className="badge-neutral text-xs py-0 px-1.5">{t(`catalog.material.${x}`)}</span>
                  ))}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {matches.length > SHOWN && <p className="text-xs text-[var(--text-tertiary)]">{t('catalog.more', { count: matches.length - SHOWN })}</p>}
    </div>
  );
}

const noteText = (t: ReturnType<typeof useT>['t'], n: CatalogNote) => t(`catalog.note.${n.kind}`, { row: n.row, code: n.code, a: n.a ?? '', b: n.b ?? '' });

/** The tool database: everyone browses it; admins load the shop's list (.csv or .xlsx) to replace it. */
export function ToolCatalogDialog({ catalog, isAdmin, onClose, onSaved }: { catalog: Catalog | null; isAdmin: boolean; onClose: () => void; onSaved: (c: Catalog) => void }) {
  const { t } = useT('tools');
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<{ file: string; tools: CatalogTool[]; notes: CatalogNote[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<number | null>(null);
  const [picked, setPicked] = useState<CatalogTool | null>(null);
  const tools = preview?.tools ?? catalog?.tools ?? [];

  const read = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    setSaved(null);
    setBusy(true);
    try {
      const rows = await readSheetRows(file);
      if (rows === 'tooLarge' || rows === 'unreadable') return setError(t(`catalog.${rows}`));
      const r = catalogFromRows(rows);
      if (!r.tools.length) return setError(t('catalog.noTools'));
      setPicked(null);
      setPreview({ file: file.name, ...r });
    } catch {
      setError(t('catalog.unreadable'));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!preview || busy || !confirm(t('catalog.confirmReplace', { count: preview.tools.length }))) return;
    setBusy(true);
    setError('');
    try {
      const res = await api<Catalog>('/tools/catalog', { method: 'PUT', body: { tools: preview.tools } });
      onSaved(res);
      setSaved(res.tools.length);
      setPreview(null);
    } catch (e) {
      setError(errorMessage(e, t('catalog.saveFailed')));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <motion.div className="fixed inset-0 modal-backdrop flex items-center justify-center p-4 z-[99999]" onMouseDown={(e) => e.target === e.currentTarget && onClose()} {...iosBackdrop}>
      <motion.div className="glass-modal max-w-3xl w-full p-6 max-h-[92vh] overflow-y-auto space-y-4" {...iosSurface} role="dialog" aria-modal="true" aria-label={t('catalog.title')}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-bold text-[var(--text-primary)] flex items-center gap-2">
              <Database size={16} className="text-[var(--blue-text)]" aria-hidden /> {t('catalog.title')}
              {catalog && <span className="badge-neutral text-xs py-0 px-2 font-mono">{t('catalog.count', { count: catalog.tools.length })}</span>}
            </h3>
            {catalog?.updatedAt && (
              <p className="text-xs text-[var(--text-tertiary)] mt-1">{t('catalog.updated', { date: fmtDateTime(catalog.updatedAt), name: catalog.updatedBy ?? '' })}</p>
            )}
          </div>
          <button onClick={onClose} className="btn-icon w-9 h-9 shrink-0" title={t('common:actions.close')} aria-label={t('common:actions.close')}>
            <X size={16} />
          </button>
        </div>

        {isAdmin ? (
          <section className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] p-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-[var(--text-secondary)]">{t('catalog.importHint')}</p>
              <button type="button" disabled={busy} onClick={() => inputRef.current?.click()} className="btn-secondary text-xs py-2 px-3 min-h-[40px]">
                <Upload size={14} aria-hidden /> <span>{busy && !preview ? t('catalog.reading') : t('catalog.import')}</span>
              </button>
              <input ref={inputRef} type="file" accept=".csv,.xlsx" className="hidden" onChange={(e) => { void read(e.target.files?.[0]); e.target.value = ''; }} />
            </div>
            {preview && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-[var(--text-primary)]">{t('catalog.readCount', { count: preview.tools.length, file: preview.file })}</p>
                {preview.notes.length > 0 && (
                  <details className="text-xs text-[var(--text-secondary)]">
                    <summary className="cursor-pointer flex items-center gap-1.5 text-[var(--orange-text)]">
                      <AlertTriangle size={13} aria-hidden /> {t('catalog.notesTitle', { count: preview.notes.length })}
                    </summary>
                    <ul className="mt-1.5 space-y-0.5 max-h-40 overflow-y-auto font-mono">
                      {preview.notes.map((n, i) => <li key={i}>{noteText(t, n)}</li>)}
                    </ul>
                  </details>
                )}
                <div className="flex flex-wrap justify-end gap-2">
                  <button type="button" onClick={() => setPreview(null)} className="btn-secondary text-xs py-2 px-3 min-h-[40px]">{t('catalog.cancel')}</button>
                  <button type="button" disabled={busy} onClick={save} className="btn-primary text-xs py-2 px-4 min-h-[40px]">{t('catalog.save', { count: preview.tools.length })}</button>
                </div>
              </div>
            )}
          </section>
        ) : (
          <p className="text-xs text-[var(--text-tertiary)]">{t('catalog.readOnly')}</p>
        )}

        {error && <div role="alert" className="badge-danger py-2 px-3 text-xs font-semibold">{error}</div>}
        {saved !== null && (
          <div role="status" className="badge-positive py-2 px-3 text-xs flex items-center gap-2"><CheckCircle2 size={14} aria-hidden /> {t('catalog.saved', { count: saved })}</div>
        )}

        {tools.length ? (
          <ToolCatalogPicker key={preview?.file ?? 'saved'} tools={tools} picked={picked} onPick={setPicked} />
        ) : (
          <p className="py-8 text-center text-sm text-[var(--text-secondary)]">{isAdmin ? t('catalog.empty') : t('catalog.emptyUser')}</p>
        )}
      </motion.div>
    </motion.div>,
    document.body,
  );
}
