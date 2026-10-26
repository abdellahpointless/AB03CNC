import React, { useState } from 'react';
import { ArrowDown, ArrowUp, Factory, Pencil, Plus, Trash2, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { api, errorMessage } from '../lib/api';
import { useSync } from '../contexts/SyncContext';
import { useT } from '../i18n';
import { currentRegion } from '../lib/instance';
import { MACHINE_BRANDS, MACHINE_IMAGES, type MachineBrand, type MachineInfo } from '../regions';
import { machineSubtitle } from '../lib/fleet';

interface Form {
  name: string;
  brand: MachineBrand;
  model: string;
  image: string;
  pockets: string;
  hasTools: boolean;
}

const EMPTY: Form = { name: '', brand: 'HAAS', model: '', image: '', pockets: '', hasTools: true };

/** Admin: the machines of this country (add, edit, remove, order on the floor). */
export default function MachineManager() {
  const { t } = useT('machines');
  const { machines, reloadMachines } = useSync();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const sorted = [...machines].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
      await reloadMachines();
      if (done) setNotice(done);
      return true;
    } catch (e) {
      setError(errorMessage(e, t('common:errors.generic')));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const openNew = () => {
    setForm(EMPTY);
    setEditing('new');
    setError('');
  };

  const openEdit = (m: MachineInfo) => {
    setForm({ name: m.name, brand: m.brand, model: m.model, image: m.image ?? '', pockets: m.pockets ? String(m.pockets) : '', hasTools: m.hasTools });
    setEditing(m.id);
    setError('');
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = {
      name: form.name.trim(),
      brand: form.brand,
      model: form.model.trim(),
      image: form.image || null,
      pockets: form.pockets ? Number(form.pockets) : null,
      hasTools: form.hasTools,
    };
    const ok = await run(
      () => (editing === 'new' ? api('/fleet', { method: 'POST', body }) : api(`/fleet/${encodeURIComponent(editing!)}`, { method: 'PATCH', body })),
      t('saved'),
    );
    if (ok) setEditing(null);
  };

  const remove = (m: MachineInfo) => {
    if (!confirm(t('confirmRemove', { name: m.name }))) return;
    run(() => api(`/fleet/${encodeURIComponent(m.id)}`, { method: 'DELETE' }), t('removed', { name: m.name }));
  };

  // Swap the floor order of two neighbours.
  const move = (index: number, dir: -1 | 1) => {
    const a = sorted[index];
    const b = sorted[index + dir];
    if (!a || !b) return;
    const sa = a.sort === b.sort ? b.sort + dir : b.sort;
    run(async () => {
      await api(`/fleet/${encodeURIComponent(a.id)}`, { method: 'PATCH', body: { sort: sa } });
      await api(`/fleet/${encodeURIComponent(b.id)}`, { method: 'PATCH', body: { sort: a.sort } });
    });
  };

  return (
    <div className="aurora-card p-0 overflow-hidden">
      <div className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-[var(--radius-md)] bg-[var(--blue-500)]/15 border border-[var(--blue-500)]/30 text-[var(--blue-text)]">
            <Factory size={20} />
          </div>
          <div>
            <h3 className="text-lg font-bold text-[var(--text-primary)]">{t('title')}</h3>
            <p className="text-xs text-[var(--text-secondary)]">
              {t('subtitle', { country: t(`common:country.${currentRegion().id}`) })} {t('engineNote')}
            </p>
          </div>
        </div>
        {editing === null && (
          <button onClick={openNew} className="btn-primary text-xs py-2 px-4 whitespace-nowrap self-start sm:self-auto">
            <Plus size={15} />
            <span>{t('add')}</span>
          </button>
        )}
      </div>

      <AnimatePresence initial={false}>
        {editing !== null && (
          <motion.form
            key="machine-form"
            onSubmit={save}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden border-b border-[var(--border-subtle)] bg-[rgba(var(--ov),0.02)]"
          >
            <div className="p-5 grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="md:col-span-3 flex items-center justify-between">
                <span className="section-label text-[var(--text-primary)]">
                  {editing === 'new' ? t('form.titleNew') : t('form.titleEdit', { name: machines.find((m) => m.id === editing)?.name ?? '' })}
                </span>
                <button type="button" onClick={() => setEditing(null)} className="btn-icon w-7 h-7" title={t('common:actions.cancel')}>
                  <X size={14} />
                </button>
              </div>
              <label className="space-y-1">
                <span className="section-label block">{t('form.name')}</span>
                <input className="aurora-input w-full text-xs" value={form.name} maxLength={40} required placeholder={t('form.namePlaceholder')} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
              </label>
              <label className="space-y-1">
                <span className="section-label block">{t('form.brand')}</span>
                <select className="aurora-input w-full text-xs cursor-pointer" value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value as MachineBrand })}>
                  {MACHINE_BRANDS.map((b) => (
                    <option key={b} value={b} className="bg-[var(--bg-panel)]">
                      {t(`common:brand.${b}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="section-label block">{t('form.model')}</span>
                <input className="aurora-input w-full text-xs" value={form.model} maxLength={40} placeholder={t('form.modelPlaceholder')} onChange={(e) => setForm({ ...form, model: e.target.value })} />
              </label>
              <label className="space-y-1">
                <span className="section-label block">{t('form.photo')}</span>
                <select className="aurora-input w-full text-xs cursor-pointer" value={form.image} onChange={(e) => setForm({ ...form, image: e.target.value })}>
                  <option value="" className="bg-[var(--bg-panel)]">{t('form.noPhoto')}</option>
                  {MACHINE_IMAGES.map((i) => (
                    <option key={i.file} value={i.file} className="bg-[var(--bg-panel)]">
                      {i.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="section-label block">{t('form.pockets')}</span>
                <input className="aurora-input w-full text-xs" type="number" min={1} max={999} value={form.pockets} onChange={(e) => setForm({ ...form, pockets: e.target.value })} />
                <span className="text-xs text-[var(--text-tertiary)] block">{t('form.pocketsHint')}</span>
              </label>
              <div className="flex items-center gap-3">
                <img src={form.image || '/machines/generic.svg'} alt="" className="w-20 h-16 object-contain rounded-[var(--radius-sm)] bg-white/80" />
                <label className="flex items-start gap-2 text-xs text-[var(--text-secondary)] cursor-pointer">
                  <input type="checkbox" className="mt-0.5" checked={form.hasTools} onChange={(e) => setForm({ ...form, hasTools: e.target.checked })} />
                  {t('form.hasTools')}
                </label>
              </div>
              <div className="md:col-span-3 flex justify-end gap-2">
                <button type="button" onClick={() => setEditing(null)} className="btn-secondary text-xs py-2 px-4">
                  {t('common:actions.cancel')}
                </button>
                <button type="submit" disabled={busy} className="btn-primary text-xs py-2 px-5">
                  {busy ? t('common:status.saving') : t('form.save')}
                </button>
              </div>
            </div>
          </motion.form>
        )}
      </AnimatePresence>

      {(error || notice) && (
        <div className="px-5 pt-4">
          {error && <div className="badge-danger text-xs py-1.5 px-3">{error}</div>}
          {notice && <div className="badge-positive text-xs py-1.5 px-3">{notice}</div>}
        </div>
      )}

      {sorted.length === 0 ? (
        <div className="p-8 text-center text-xs text-[var(--text-tertiary)]">{t('empty')}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-[var(--border-subtle)] bg-[rgba(var(--ov),0.02)]">
                <th className="p-3 section-label">{t('col.machine')}</th>
                <th className="p-3 section-label">{t('col.brandModel')}</th>
                <th className="p-3 section-label">{t('col.pockets')}</th>
                <th className="p-3 section-label">{t('col.tools')}</th>
                <th className="p-3 section-label text-right">{t('col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((m, i) => (
                <tr key={m.id} className="border-b border-[var(--border-subtle)] last:border-0 hover:bg-[rgba(var(--ov),0.02)]">
                  <td className="p-3">
                    <div className="flex items-center gap-3">
                      <img src={m.image || '/machines/generic.svg'} alt="" className="w-12 h-9 object-contain rounded-[var(--radius-sm)] bg-white/80" loading="lazy" />
                      <span className="font-semibold text-[var(--text-primary)]">{m.name}</span>
                    </div>
                  </td>
                  <td className="p-3 text-[var(--text-secondary)]">{machineSubtitle(m) || '-'}</td>
                  <td className="p-3 font-mono text-[var(--text-secondary)]">{m.pockets ?? '-'}</td>
                  <td className="p-3">
                    <span className={m.hasTools ? 'badge-positive text-xs py-0 px-2' : 'badge-neutral text-xs py-0 px-2'}>{m.hasTools ? t('yes') : t('no')}</span>
                  </td>
                  <td className="p-3 text-right">
                    <div className="inline-flex items-center gap-1.5">
                      <button className="btn-icon w-8 h-8 inline-flex" disabled={busy || i === 0} onClick={() => move(i, -1)} title={t('moveUp')} aria-label={t('moveUp')}>
                        <ArrowUp size={13} />
                      </button>
                      <button className="btn-icon w-8 h-8 inline-flex" disabled={busy || i === sorted.length - 1} onClick={() => move(i, 1)} title={t('moveDown')} aria-label={t('moveDown')}>
                        <ArrowDown size={13} />
                      </button>
                      <button className="btn-icon w-8 h-8 inline-flex" disabled={busy} onClick={() => openEdit(m)} title={t('common:actions.edit')} aria-label={t('common:actions.edit')}>
                        <Pencil size={13} />
                      </button>
                      <button
                        className="btn-icon w-8 h-8 inline-flex hover:text-[var(--rose-500)]"
                        disabled={busy}
                        onClick={() => remove(m)}
                        title={t('common:actions.remove')}
                        aria-label={t('common:actions.remove')}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
