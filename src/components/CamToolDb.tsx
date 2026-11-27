import { useEffect, useMemo, useState } from 'react';
import { Dialog } from 'radix-ui';
import { useTranslation } from 'react-i18next';
import { IconArrowBackUp as Undo, IconPlus as Plus, IconSearch as Search, IconTrash as Trash, IconX as X, IconDatabase as Database } from '@tabler/icons-react';
import '../i18n/camLocales';
import { fmtNumber as fmt } from '../i18n/format';
import { api } from '../lib/api';
import { LIBRARY } from '../lib/cam/tools';
import { ADDABLE, cleanDbTool, codeOf, FAMILIES, KINDS_OF, searchNeedle, type DbCut, type DbTool, type ToolDb } from '../lib/cam/toolDb';
import type { Family, TemplateKind, TemplateTool } from '../lib/cam/templates';

/*
 * CAM AI's tool database (item 20): every tool it may use, by material family and type. The shop changes a
 * tool's cutting data per operation, removes it, puts it back, or adds a tool; saved for the whole shop
 * (worker/routes/lab.ts) and checked when a program is made as typed values are (tools.ts, cutData).
 */

const TYPES = ['SF', 'SFH', 'MK', 'SB', 'ZB', 'AB', 'ST', 'KS', 'KF', 'TF', 'UDM', 'RA'] as const;
type ToolType = (typeof TYPES)[number];
const FIELDS: (keyof DbCut)[] = ['s', 'f', 'ap', 'ae'];
/** The tool inspector's words for them. */
const LABEL = { s: 'camAi.cut.rpm', f: 'camAi.cut.feed', ap: 'camAi.cut.ap', ae: 'camAi.cut.ae' } as const;

interface Row {
  code: string;
  type: string;
  d: number;
  length: number;
  template: TemplateTool | null;
  db?: DbTool;
}
type Draft = Partial<Record<TemplateKind, Partial<Record<keyof DbCut, string>>>>;
export interface Stored {
  db: ToolDb;
  /** Who changed each tool last, by family and code. */
  by: Record<string, string>;
}

/** The shop's database as saved (rows the planner may not take left out). */
export async function loadToolDb(): Promise<Stored> {
  const r = await api<{ tools: { family: Family; code: string; tool: DbTool; by: string }[] }>('/lab/tools');
  const db: ToolDb = {};
  const by: Record<string, string> = {};
  for (const x of r.tools) {
    (db[x.family] ??= {})[x.code] = x.tool;
    by[`${x.family}/${x.code}`] = x.by;
  }
  return { db, by };
}

/** A template op's own values, as the placeholders of its row. */
function templateValues(t: TemplateTool, kind: TemplateKind): Record<keyof DbCut, string> {
  const op = t.ops.find((o) => o.kind === kind);
  if (!op) return { s: '', f: '', ap: '', ae: '' };
  const ae = op.ae ? ('share' in op.ae ? op.ae.share * t.d : op.ae.mm) : null;
  return { s: String(Math.round(op.rpm)), f: String(Math.round(op.feed)), ap: op.ap === null ? '' : String(op.ap), ae: ae === null ? '' : String(Math.round(ae * 100) / 100) };
}

const kindsOf = (r: Pick<Row, 'template' | 'type'>): TemplateKind[] => (r.template ? [...new Set(r.template.ops.map((o) => o.kind))] : (KINDS_OF[r.type] ?? []));

function draftOf(r: Row | null): Draft {
  const out: Draft = {};
  for (const [k, c] of Object.entries(r?.db?.cuts ?? {})) out[k as TemplateKind] = Object.fromEntries(Object.entries(c).map(([f, v]) => [f, String(v)]));
  return out;
}

/** The typed values as saved: empty fields left to the template (or the shop's programs). */
function cutsOf(d: Draft): DbTool['cuts'] | undefined {
  const cuts: NonNullable<DbTool['cuts']> = {};
  for (const [k, c] of Object.entries(d)) {
    const v: DbCut = {};
    for (const f of FIELDS) if (c?.[f]?.trim()) v[f] = Number(c[f]!.replace(',', '.'));
    if (Object.keys(v).length) cuts[k as TemplateKind] = v;
  }
  return Object.keys(cuts).length ? cuts : undefined;
}

export default function CamToolDb({ open, onOpenChange, stored, onSaved, family: first, onChanged }: { open: boolean; onOpenChange: (o: boolean) => void; stored: Stored; onSaved: (s: Stored) => void; family?: Family; /** A tool saved or deleted (its code): the page asks to make again a program that uses it. */ onChanged?: (code: string) => void }) {
  const { t } = useTranslation('cam');
  const typeName = (k: string) => t(`camAi.db.type.${k as ToolType}`);
  const [fam, setFam] = useState<Family>(first ?? 'ALU');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ type: string; d: string; length: string } | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  // Its role, whether CAM AI may use it, and (an added tool) its type (item 14).
  const [meta, setMeta] = useState<{ role?: 'rough' | 'finish'; off?: true; type?: string }>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Fresh from the server each time it opens: someone else may have changed it.
  useEffect(() => {
    if (!open) return;
    if (first) setFam(first);
    loadToolDb().then(onSaved, () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const own = stored.db[fam] ?? {};
  const rows = useMemo<Row[]>(() => {
    const base: Row[] = LIBRARY[fam].map((x) => ({ code: x.code, type: x.type, d: x.d, length: x.length, template: x, db: own[x.code] }));
    const added: Row[] = Object.entries(own)
      .filter(([c, r]) => r.added && !LIBRARY[fam].some((x) => x.code === c))
      .map(([c, r]) => ({ code: c, type: r.added!.type, d: r.added!.d, length: r.added!.length, template: null, db: r }));
    return [...base, ...added];
  }, [fam, own]);
  const needle = searchNeedle(q);
  const shown = rows.filter((r) => !needle || r.code.includes(needle) || fmt(r.d, 2).replace(',', '.') === needle || String(r.d) === needle);
  const groups = TYPES.map((type) => [type, shown.filter((r) => r.type === type).sort((a, b) => a.d - b.d || a.length - b.length)] as const).filter(([, rs]) => rs.length);
  const row = rows.find((r) => r.code === sel) ?? null;

  const pick = (r: Row | null) => {
    setSel(r?.code ?? null);
    setAdding(null);
    setDraft(draftOf(r));
    setMeta({ role: r?.db?.role, off: r?.db?.off, type: r && !r.template ? r.type : undefined });
    setErr(null);
  };
  useEffect(() => pick(null), [fam]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = (code: string, tool: DbTool | null) => {
    const db = { ...stored.db, [fam]: { ...own } };
    if (tool) db[fam]![code] = tool;
    else delete db[fam]![code];
    onSaved({ db, by: { ...stored.by, [`${fam}/${code}`]: tool ? t('camAi.db.you') : '' } });
  };
  const send = async (code: string, tool: DbTool | null) => {
    setBusy(true);
    setErr(null);
    try {
      if (tool) {
        if (!cleanDbTool(fam, code, tool)) throw new Error(t('camAi.db.invalid'));
        await api('/lab/tools', { method: 'PUT', body: { family: fam, code, tool } });
      } else await api(`/lab/tools?family=${fam}&code=${encodeURIComponent(code)}`, { method: 'DELETE' });
      apply(code, tool);
      onChanged?.(code);
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const extra = { ...(meta.role ? { role: meta.role } : {}), ...(meta.off ? { off: true as const } : {}) };
    if (adding) {
      const d = Number(adding.d.replace(',', '.'));
      const length = Number(adding.length.replace(',', '.'));
      const code = codeOf(adding.type, d, length, fam);
      if (rows.some((r) => r.code === code)) return setErr(t('camAi.db.exists'));
      const cuts = cutsOf(draft);
      if (await send(code, { added: { type: adding.type, d, length: Math.round(length) }, ...(cuts ? { cuts } : {}), ...extra })) {
        setAdding(null);
        setSel(code);
      }
      return;
    }
    if (!row) return;
    const cuts = cutsOf(draft);
    if (row.template) await send(row.code, cuts || Object.keys(extra).length ? { ...(cuts ? { cuts } : {}), ...extra } : null);
    else if (meta.type && meta.type !== row.type) {
      // Another type: another code. Saved under it first, then the old one deleted; its cuts for the old type go.
      const code = codeOf(meta.type, row.d, row.length, fam);
      if (rows.some((r) => r.code === code)) return setErr(t('camAi.db.exists'));
      const kept = cuts && Object.fromEntries(Object.entries(cuts).filter(([k]) => (KINDS_OF[meta.type!] ?? []).includes(k as TemplateKind)));
      if (await send(code, { added: { type: meta.type, d: row.d, length: row.length }, ...(kept && Object.keys(kept).length ? { cuts: kept } : {}), ...extra })) {
        if (await send(row.code, null)) setSel(code);
      }
    } else await send(row.code, { added: row.db!.added, ...(cuts ? { cuts } : {}), ...extra });
  };

  const chip = (r: Row) =>
    r.db?.off ? (
      <span className="text-[11px] px-1.5 rounded bg-[rgba(var(--ov),0.08)] text-[var(--orange-text)]">{t('camAi.db.offChip')}</span>
    ) : r.db?.removed ? (
      <span className="text-[11px] px-1.5 rounded bg-[rgba(var(--ov),0.08)] text-[var(--text-secondary)]">{t('camAi.db.removed')}</span>
    ) : !r.template ? (
      <span className="text-[11px] px-1.5 rounded bg-[var(--green-500)]/15 text-[var(--green-text)]">{t('camAi.db.added')}</span>
    ) : r.db?.cuts ? (
      <span className="text-[11px] px-1.5 rounded bg-[var(--blue-500)]/15 text-[var(--blue-text)]">{t('camAi.db.changed')}</span>
    ) : null;

  const editing = adding ?? row;
  const kinds = adding ? (KINDS_OF[adding.type] ?? []) : row ? kindsOf(row) : [];
  const field = (kind: TemplateKind, f: keyof DbCut, placeholder: string) => (
    <input
      className="aurora-input w-full h-8 py-0 px-2 text-[13px] tabular-nums"
      type="text"
      inputMode="decimal"
      aria-label={`${t(`camAi.db.kind.${kind}`)} · ${t(LABEL[f])}`}
      placeholder={placeholder}
      value={draft[kind]?.[f] ?? ''}
      disabled={busy || !!row?.db?.removed}
      onChange={(e) => setDraft({ ...draft, [kind]: { ...draft[kind], [f]: e.target.value } })}
    />
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[1000] bg-black/45 backdrop-blur-[2px]" />
        <Dialog.Content className="glass-modal fixed z-[1001] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[60rem] max-w-[calc(100vw-2rem)] h-[85vh] flex flex-col p-0 overflow-hidden">
          <div className="flex items-start gap-3 px-5 pt-4 pb-3 border-b border-[var(--border-subtle)]">
            <Database size={20} stroke={1.6} className="mt-0.5 text-[var(--blue-text)] shrink-0" aria-hidden />
            <div className="flex-1 min-w-0">
              <Dialog.Title className="text-sm font-semibold text-[var(--text-primary)]">{t('camAi.db.title')}</Dialog.Title>
              <Dialog.Description className="text-xs text-[var(--text-secondary)] mt-0.5">{t('camAi.db.intro')}</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="no-glass w-9 h-9 grid place-items-center rounded-[8px] hover:bg-[rgba(var(--ov),0.08)]" aria-label={t('camAi.db.close')}>
                <X size={18} stroke={1.6} />
              </button>
            </Dialog.Close>
          </div>

          <div className="flex flex-wrap items-center gap-2 px-5 py-2.5 border-b border-[var(--border-subtle)]">
            <div role="radiogroup" aria-label={t('camAi.db.family')} className="flex rounded-[8px] border border-[var(--border-subtle)] overflow-hidden">
              {FAMILIES.map((f) => (
                <button key={f} type="button" role="radio" aria-checked={fam === f} title={t(`camAi.db.families.${f}`)} onClick={() => setFam(f)} className={`no-glass h-8 px-3 text-[13px] font-medium ${fam === f ? 'bg-[var(--blue-500)] text-white' : 'text-[var(--text-primary)] hover:bg-[rgba(var(--ov),0.08)]'}`}>
                  {f}
                </button>
              ))}
            </div>
            <span className="text-xs text-[var(--text-secondary)]">{t(`camAi.db.families.${fam}`)}</span>
            <label className="relative ml-auto">
              <Search size={15} stroke={1.6} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-secondary)]" aria-hidden />
              <input className="aurora-input h-8 py-0 pr-2 w-48 text-[13px]" style={{ paddingLeft: 30 }} type="search" placeholder={t('camAi.db.search')} aria-label={t('camAi.db.search')} value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
            <button type="button" className="btn-secondary h-8 px-3 text-[13px] inline-flex items-center gap-1.5" onClick={() => { pick(null); setAdding({ type: 'SF', d: '', length: '' }); }} disabled={busy}>
              <Plus size={15} stroke={1.8} aria-hidden /> {t('camAi.db.add')}
            </button>
          </div>

          <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[1fr_22rem]">
            <div className="min-h-0 overflow-y-auto px-3 pb-2" role="listbox" aria-label={t('camAi.db.title')}>
              {groups.length === 0 && <p className="px-2 py-6 text-[13px] text-[var(--text-secondary)]">{t('camAi.db.none')}</p>}
              {groups.map(([type, rs]) => (
                <section key={type} className="mb-3">
                  <h3 className="px-2 pt-2.5 pb-1 text-xs font-semibold text-[var(--text-secondary)]">
                    {typeName(type)} <span className="font-normal">· {type} · {rs.length}</span>
                    {!(type in ADDABLE) && <span className="font-normal"> · {t('camAi.db.notPlanned')}</span>}
                  </h3>
                  {rs.map((r) => (
                    <button
                      key={r.code}
                      type="button"
                      role="option"
                      aria-selected={sel === r.code}
                      onClick={() => pick(r)}
                      className={`no-glass w-full flex items-center gap-3 h-9 px-2 rounded-[6px] text-left text-[13px] ${sel === r.code ? 'bg-[var(--blue-500)]/12 ring-1 ring-[var(--blue-500)]/40' : 'hover:bg-[rgba(var(--ov),0.06)]'} ${r.db?.removed ? 'opacity-55' : ''}`}
                    >
                      <span className="w-14 shrink-0 tabular-nums font-medium text-[var(--text-primary)]">Ø{fmt(r.d, r.d % 1 ? 2 : 0)}</span>
                      <span className="w-24 shrink-0 whitespace-nowrap tabular-nums text-[var(--text-secondary)]">{t('camAi.db.long', { mm: fmt(r.length, 0) })}</span>
                      <span className={`flex-1 truncate font-mono text-xs text-[var(--text-secondary)] ${r.db?.removed ? 'line-through' : ''}`}>{r.code}</span>
                      {chip(r)}
                    </button>
                  ))}
                </section>
              ))}
            </div>

            <aside className="min-h-0 overflow-y-auto border-t md:border-t-0 md:border-l border-[var(--border-subtle)] px-4 py-3 space-y-3" aria-label={t('camAi.db.editor')}>
              {!editing && <p className="text-[13px] text-[var(--text-secondary)]">{t('camAi.db.pick')}</p>}
              {adding && (
                <div className="space-y-2">
                  <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">{t('camAi.db.addTitle')}</h3>
                  <div className="grid grid-cols-3 gap-2">
                    <label className="space-y-1 col-span-3">
                      <span className="block text-xs text-[var(--text-secondary)]">{t('camAi.db.typeLabel')}</span>
                      <select className="aurora-input w-full h-8 py-0 text-[13px]" value={adding.type} onChange={(e) => { setAdding({ ...adding, type: e.target.value }); setDraft({}); }}>
                        {Object.keys(ADDABLE).map((k) => <option key={k} value={k}>{typeName(k)} ({k})</option>)}
                      </select>
                    </label>
                    <label className="space-y-1">
                      <span className="block text-xs text-[var(--text-secondary)]">{t('camAi.db.d')}</span>
                      <input className="aurora-input w-full h-8 py-0 px-2 text-[13px]" inputMode="decimal" value={adding.d} onChange={(e) => setAdding({ ...adding, d: e.target.value })} />
                    </label>
                    <label className="space-y-1 col-span-2">
                      <span className="block text-xs text-[var(--text-secondary)]">{t('camAi.db.length')}</span>
                      <input className="aurora-input w-full h-8 py-0 px-2 text-[13px]" inputMode="decimal" value={adding.length} onChange={(e) => setAdding({ ...adding, length: e.target.value })} />
                    </label>
                  </div>
                  {Number(adding.d.replace(',', '.')) > 0 && Number(adding.length.replace(',', '.')) > 0 && (
                    <p className="text-xs text-[var(--text-secondary)]">{t('camAi.db.code')}: <span className="font-mono">{codeOf(adding.type, Number(adding.d.replace(',', '.')), Number(adding.length.replace(',', '.')), fam)}</span></p>
                  )}
                  <p className="text-xs text-[var(--text-secondary)]">{t('camAi.db.addHint')}</p>
                </div>
              )}
              {row && (
                <div className="space-y-1">
                  <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">
                    {typeName(row.type)} Ø{fmt(row.d, row.d % 1 ? 2 : 0)} · {t('camAi.db.long', { mm: fmt(row.length, 0) })}
                  </h3>
                  <p className="font-mono text-xs text-[var(--text-secondary)] break-all">{row.code}</p>
                  {stored.by[`${fam}/${row.code}`] && <p className="text-xs text-[var(--text-secondary)]">{t('camAi.db.by', { who: stored.by[`${fam}/${row.code}`] })}</p>}
                  {row.db?.removed && <p className="text-xs text-[var(--text-secondary)]">{t('camAi.db.removedHint')}</p>}
                </div>
              )}
              {editing && !row?.db?.removed && (
                <div className="space-y-2.5">
                  {row && !row.template && (
                    <label className="block space-y-1">
                      <span className="block text-xs text-[var(--text-secondary)]">{t('camAi.db.typeLabel')}</span>
                      <select className="aurora-input w-full h-8 py-0 text-[13px]" value={meta.type ?? row.type} onChange={(e) => setMeta({ ...meta, type: e.target.value })} disabled={busy}>
                        {Object.keys(ADDABLE).map((k) => <option key={k} value={k}>{typeName(k)} ({k})</option>)}
                      </select>
                      {meta.type && meta.type !== row.type && <span className="block text-xs text-[var(--orange-text)]">{t('camAi.db.typeChange')}</span>}
                    </label>
                  )}
                  <fieldset className="space-y-1">
                    <legend className="text-xs text-[var(--text-secondary)]">{t('camAi.db.role')}</legend>
                    <div role="radiogroup" aria-label={t('camAi.db.role')} className="inline-flex flex-wrap rounded-[8px] border border-[var(--border-subtle)] p-0.5">
                      {([undefined, 'rough', 'finish'] as const).map((v) => (
                        <button key={v ?? 'both'} type="button" role="radio" aria-checked={meta.role === v} onClick={() => setMeta({ ...meta, role: v })} disabled={busy} className={`no-glass h-8 px-2.5 rounded-[6px] text-xs ${meta.role === v ? 'bg-[var(--blue-500)]/15 text-[var(--text-primary)] font-medium' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}>
                          {t(v === 'rough' ? 'camAi.db.roleRough' : v === 'finish' ? 'camAi.db.roleFinish' : 'camAi.db.roleBoth')}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <label className="flex items-start gap-2 text-[13px] text-[var(--text-primary)] cursor-pointer">
                    <input type="checkbox" className="mt-0.5 w-4 h-4 accent-[var(--blue-500)]" checked={!meta.off} onChange={(e) => setMeta({ ...meta, off: e.target.checked ? undefined : true })} disabled={busy} />
                    <span>
                      {t('camAi.db.on')}
                      <span className="block text-xs text-[var(--text-secondary)]">{t('camAi.db.onHint')}</span>
                    </span>
                  </label>
                </div>
              )}
              {editing && kinds.length > 0 && (
                <div className="space-y-2.5">
                  <p className="text-xs text-[var(--text-secondary)]">{row?.template ? t('camAi.db.blankTemplate') : t('camAi.db.blankLearned')}</p>
                  {kinds.map((kind) => {
                    const tpl = row?.template ? templateValues(row.template, kind) : { s: '', f: '', ap: '', ae: '' };
                    const name = row?.template?.ops.find((o) => o.kind === kind)?.name;
                    return (
                      <fieldset key={kind} className="space-y-1">
                        <legend className="text-xs font-medium text-[var(--text-primary)]">
                          {t(`camAi.db.kind.${kind}`)} {name && <span className="font-mono font-normal text-[var(--text-secondary)]">({name})</span>}
                        </legend>
                        <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
                          {FIELDS.map((f) => (
                            <label key={f} className="space-y-0.5">
                              <span className="block text-[11px] text-[var(--text-secondary)]">{t(LABEL[f])}</span>
                              {field(kind, f, tpl[f])}
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    );
                  })}
                  <p className="text-xs text-[var(--text-secondary)]">{t('camAi.db.checked')}</p>
                </div>
              )}
              {err && <p role="alert" className="text-xs text-[#ef4444]">{err}</p>}
              {editing && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {!row?.db?.removed && (
                    <button type="button" className="btn-primary h-9 px-3.5 text-[13px]" onClick={() => void save()} disabled={busy || (!!adding && !(Number(adding.d.replace(',', '.')) > 0 && Number(adding.length.replace(',', '.')) > 0))}>
                      {busy ? t('camAi.db.saving') : t('camAi.db.save')}
                    </button>
                  )}
                  {adding && <button type="button" className="btn-secondary h-9 px-3 text-[13px]" onClick={() => setAdding(null)} disabled={busy}>{t('camAi.cancel')}</button>}
                  {row?.template && !row.db?.removed && (
                    <button type="button" className="btn-secondary h-9 px-3 text-[13px] inline-flex items-center gap-1.5" onClick={() => void send(row.code, { removed: true })} disabled={busy}>
                      <Trash size={15} stroke={1.6} aria-hidden /> {t('camAi.db.remove')}
                    </button>
                  )}
                  {row?.template && row.db && (
                    <button type="button" className="btn-secondary h-9 px-3 text-[13px] inline-flex items-center gap-1.5" onClick={() => void send(row.code, null).then((ok) => ok && setDraft({}))} disabled={busy}>
                      <Undo size={15} stroke={1.6} aria-hidden /> {row.db.removed ? t('camAi.db.restore') : t('camAi.db.reset')}
                    </button>
                  )}
                  {row && !row.template && (
                    <button type="button" className="btn-secondary h-9 px-3 text-[13px] inline-flex items-center gap-1.5" onClick={() => void send(row.code, null).then((ok) => ok && pick(null))} disabled={busy}>
                      <Trash size={15} stroke={1.6} aria-hidden /> {t('camAi.db.delete')}
                    </button>
                  )}
                </div>
              )}
            </aside>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
