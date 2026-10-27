import { useCallback, useEffect, useMemo, useState } from 'react';
import { Boxes, CheckCircle2, Download, FileText, X } from 'lucide-react';
import { useSync } from '../contexts/SyncContext';
import { CALE_HEIGHTS, MIN_SPARE, lowStock, orderRows } from '../lib/cales';
import { decideCales, fetchCalesLog, fetchCalesStock, setCalesOnMachine, setCalesStock, timeAgo, toFleet } from '../lib/fleet';
import { currentRegion } from '../lib/instance';
import { dayStart, periodStart } from '../lib/shifts';
import { errorMessage } from '../lib/api';
import { fmtDate } from '../i18n/format';
import { useT } from '../i18n';

/*
 * Admin: what is really in each machine's box, the spare cales (security stock, counted one by one)
 * per machine and height, the requests for new cales, and the Excel file of what to order. Approving a request takes the cales from this stock, puts the
 * pair back in its box and logs it, in one transaction on the server.
 */

type Data = Awaited<ReturnType<typeof fetchCalesStock>>;
type Period = 'week' | 'month' | 'custom';

export default function CalesStock() {
  const { t } = useT('preventive');
  const { machines, versions } = useSync();
  const fleet = useMemo(() => toFleet(machines), [machines]);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>('week');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [view, setView] = useState<'machine' | 'stock'>('machine');

  const load = useCallback(async () => {
    try {
      setData(await fetchCalesStock());
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, versions.machines]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError('');
    try {
      await fn();
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const qty = (m: string, h: number) => data?.stock.find((s) => s.machine_id === m && s.height === h)?.qty ?? 0;
  const stateOf = (m: string, h: number) => data?.state.find((s) => s.machine_id === m && s.height === h);
  const nameOf = (id: string) => fleet.find((m) => m.id === id)?.name ?? id;
  // What to order: every machine and size whose security stock is under MIN_SPARE single cales.
  const low = useMemo(() => (data ? lowStock(fleet.map((m) => m.id), data.stock) : []), [data, fleet]);
  const bySize = CALE_HEIGHTS.map((h) => ({ h, need: low.filter((r) => r.height === h).reduce((n, r) => n + r.need, 0) })).filter((r) => r.need);

  /** The order as a clean page in a new window, and the print dialog: "Save as PDF" makes the file. */
  const exportPdf = () => {
    const w = window.open('', '_blank');
    if (!w) return setError(t('stock.popupBlocked'));
    const esc = (v: string | number) => String(v).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const day = new Date().toISOString().slice(0, 10);
    const cell = (v: string | number, right = false) => `<td${right ? ' class="n"' : ''}>${esc(v)}</td>`;
    w.document.write(`<!doctype html><html lang="${document.documentElement.lang}"><head><meta charset="utf-8"><title>${esc(`${t('stock.pdfFile')}-${day}`)}</title>
<style>body{font:13px/1.45 system-ui,sans-serif;color:#111;margin:32px}h1{font-size:20px;margin:0}p{color:#444;margin:4px 0 18px}h2{font-size:15px;margin:22px 0 8px}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:6px 9px;text-align:left}th{background:#eee}td.n{text-align:right}tfoot td{font-weight:700}</style></head><body>
<h1>${esc(t('stock.pdfTitle'))}</h1><p>${esc(`${currentRegion().name} · ${fmtDate(Date.now())} · ${t('stock.toOrderHelp', { min: MIN_SPARE })}`)}</p>
<h2>${esc(t('stock.bySize'))}</h2><table><thead><tr><th>${esc(t('stock.size'))}</th><th>${esc(t('stock.toOrderCol'))}</th></tr></thead><tbody>
${bySize.map((r) => `<tr>${cell(`${r.h} mm`)}${cell(r.need, true)}</tr>`).join('')}</tbody>
<tfoot><tr>${cell(t('stock.total'))}${cell(bySize.reduce((n, r) => n + r.need, 0), true)}</tr></tfoot></table>
<h2>${esc(t('stock.byMachine'))}</h2><table><thead><tr><th>${esc(t('stock.machine'))}</th><th>${esc(t('stock.size'))}</th><th>${esc(t('stock.inStock'))}</th><th>${esc(t('stock.toOrderCol'))}</th></tr></thead><tbody>
${low.map((r) => `<tr>${cell(nameOf(r.machine_id))}${cell(`${r.height} mm`)}${cell(r.stock, true)}${cell(r.need, true)}</tr>`).join('')}</tbody></table></body></html>`);
    w.document.close();
    w.focus();
    w.print();
  };

  const exportOrder = (d: Data) =>
    run('export', async () => {
      const tz = currentRegion().timeZone;
      const now = Date.now();
      const ymd = (s: string) => s.split('-').map(Number);
      const [fy, fm, fd] = ymd(from);
      const [ty, tm, td] = ymd(to);
      const [start, end] =
        period === 'custom' ? [dayStart(fy, fm, fd, tz), dayStart(ty, tm, td + 1, tz)] : [periodStart(period === 'week' ? 'WEEKLY' : 'MONTHLY', now, tz), now + 1];
      const { events } = await fetchCalesLog(start, end);
      const { exportCalesOrder } = await import('../lib/calesExport');
      await exportCalesOrder({ rows: orderRows(d.state, d.stock), events, fleet, state: d.state, stock: d.stock, from: start, to: end });
    });

  return (
    <div className="aurora-card p-0 overflow-hidden">
      <div className="p-5 flex flex-col lg:flex-row lg:items-end justify-between gap-4 border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-[var(--radius-md)] bg-[var(--blue-500)]/15 border border-[var(--blue-500)]/30 text-[var(--blue-text)]">
            <Boxes size={20} />
          </div>
          <div>
            <h2 className="text-lg font-bold text-[var(--text-primary)]">{t('stock.title')}</h2>
            <p className="text-xs text-[var(--text-secondary)]">{t('stock.subtitle')}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2 lg:shrink-0">
          <label className="flex flex-col gap-1">
            <span className="section-label">{t('stock.period')}</span>
            <select className="aurora-input text-xs" value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
              <option value="week">{t('stock.thisWeek')}</option>
              <option value="month">{t('stock.thisMonth')}</option>
              <option value="custom">{t('stock.custom')}</option>
            </select>
          </label>
          {period === 'custom' && (
            <>
              <label className="flex flex-col gap-1">
                <span className="section-label">{t('stock.from')}</span>
                <input type="date" className="aurora-input text-xs" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="section-label">{t('stock.to')}</span>
                <input type="date" className="aurora-input text-xs" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
              </label>
            </>
          )}
          <button
            className="btn-primary text-xs py-2 px-4 whitespace-nowrap"
            disabled={!data || !!busy || (period === 'custom' && (!from || !to || from > to))}
            onClick={() => data && exportOrder(data)}
          >
            <Download size={14} />
            <span>{busy === 'export' ? '...' : t('stock.export')}</span>
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" className="badge-danger m-4 mb-0 justify-center py-2 text-xs">
          {error}
        </div>
      )}

      {!data ? (
        <div className="p-8 text-center text-xs text-[var(--text-tertiary)]">{t('stock.loading')}</div>
      ) : (
        <div className="p-5 space-y-6">
          <section className="space-y-2" aria-labelledby="cales-to-order">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 id="cales-to-order" className="section-label">
                  {t('stock.toOrder')}
                </h3>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">{t('stock.toOrderHelp', { min: MIN_SPARE })}</p>
              </div>
              <button type="button" className="btn-primary text-xs py-2 px-4" disabled={!low.length} onClick={exportPdf}>
                <FileText size={14} />
                <span>{t('stock.pdf')}</span>
              </button>
            </div>
            {low.length === 0 ? (
              <p className="text-xs text-[var(--text-secondary)]">{t('stock.nothingToOrder', { min: MIN_SPARE })}</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5" aria-label={t('stock.bySize')}>
                  {bySize.map((r) => (
                    <span key={r.h} className="badge-warning">
                      {r.h} mm · {t('stock.nCales', { count: r.need })}
                    </span>
                  ))}
                </div>
                <div className="overflow-x-auto max-h-80" tabIndex={0} role="region" aria-label={t('stock.byMachine')}>
                  <table className="w-full border-collapse text-xs">
                    <thead>
                      <tr className="text-left">
                        <th scope="col" className="p-2 section-label">{t('stock.machine')}</th>
                        <th scope="col" className="p-2 section-label">{t('stock.size')}</th>
                        <th scope="col" className="p-2 section-label text-right">{t('stock.inStock')}</th>
                        <th scope="col" className="p-2 section-label text-right">{t('stock.toOrderCol')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {low.map((r) => (
                        <tr key={`${r.machine_id}|${r.height}`} className="border-t border-[var(--border-subtle)]">
                          <th scope="row" className="p-2 text-left font-semibold text-[var(--text-primary)]">{nameOf(r.machine_id)}</th>
                          <td className="p-2 text-[var(--text-primary)]">{r.height} mm</td>
                          <td className="p-2 text-right text-[var(--text-secondary)]">{r.stock}</td>
                          <td className="p-2 text-right font-bold text-[var(--orange-text)]">{r.need}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="section-label">{t('stock.requests')}</h3>
            {data.requests.length === 0 ? (
              <p className="text-xs text-[var(--text-tertiary)]">{t('stock.noRequests')}</p>
            ) : (
              data.requests.map((r) => {
                const back = !stateOf(r.machine_id, r.height); // the pair turned up again since
                const short = qty(r.machine_id, r.height) < r.count;
                const s = r.kind === 'MISSING' ? 'missing' : 'damaged';
                return (
                  <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[rgba(var(--ov),0.02)] text-xs">
                    <span className="font-semibold text-[var(--text-primary)]">{nameOf(r.machine_id)}</span>
                    <span className="text-[var(--text-primary)]">{t('cales.pair', { h: r.height })}</span>
                    <span className={`cales-state s-${s}`}>
                      {t(`cales.state.${s}`)} · {t('stock.nCales', { count: r.count })}
                    </span>
                    <span className="text-[var(--text-secondary)]">{t('stock.askedBy', { user: r.requested_by, time: timeAgo(r.at) })}</span>
                    <span className="ml-auto flex flex-wrap items-center gap-1.5">
                      {back ? (
                        <span className="badge-neutral">{t('stock.foundAgain')}</span>
                      ) : (
                        short && <span className="badge-danger">{t('stock.outOfStock')}</span>
                      )}
                      <button
                        className="btn-success text-xs py-1.5 px-3"
                        disabled={!!busy || back || short}
                        onClick={() => run(`ok:${r.id}`, () => decideCales(r.id, 'APPROVE'))}
                      >
                        <CheckCircle2 size={13} />
                        <span>{t('stock.approve')}</span>
                      </button>
                      <button className="btn-secondary text-xs py-1.5 px-3" disabled={!!busy} onClick={() => run(`no:${r.id}`, () => decideCales(r.id, 'REJECT'))}>
                        <X size={13} />
                        <span>{t('stock.reject')}</span>
                      </button>
                    </span>
                  </div>
                );
              })
            )}
          </section>

          <section className="space-y-3">
            <div role="tablist" aria-label={t('stock.views')} className="inline-flex rounded-full border border-[var(--border-subtle)] p-1 gap-1">
              {(['machine', 'stock'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={view === v}
                  onClick={() => setView(v)}
                  className={`no-glass rounded-full px-3.5 py-1.5 text-xs font-semibold ${view === v ? 'bg-[var(--blue-500)] text-white' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
                >
                  {t(v === 'machine' ? 'stock.onMachine' : 'stock.securityStock')}
                </button>
              ))}
            </div>
            <p className="text-xs text-[var(--text-tertiary)]">{t(view === 'machine' ? 'stock.onMachineHelp' : 'stock.gridHelp')}</p>
            <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={t(view === 'machine' ? 'stock.onMachine' : 'stock.securityStock')}>
              <table className="border-collapse text-xs">
                <thead>
                  <tr>
                    <th scope="col" className="p-2 section-label text-left">
                      {t('stock.machine')}
                    </th>
                    {CALE_HEIGHTS.map((h) => (
                      <th key={h} scope="col" className="p-1 section-label text-center">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {fleet.map((m) => (
                    <tr key={m.id} className="border-t border-[var(--border-subtle)]">
                      <th scope="row" className="p-2 pr-3 text-left font-semibold text-[var(--text-primary)] whitespace-nowrap">
                        {m.name}
                      </th>
                      {CALE_HEIGHTS.map((h) => {
                        const st = stateOf(m.id, h);
                        const s = st ? (st.status === 'MISSING' ? 'missing' : 'damaged') : null;
                        if (view === 'machine') {
                          // Single cales really in the box: a missing pair shows 0, one missing shows 1.
                          const present = st?.status === 'MISSING' ? 2 - st.count : 2;
                          return (
                            <td key={h} className="p-1 text-center">
                              <select
                                aria-label={`${t('stock.onMachineCell', { machine: m.name, h })}${s ? `, ${t(`cales.state.${s}`)}` : ''}`}
                                className={`aurora-input stock-cell ${s ? `s-${s}` : ''}`}
                                value={present}
                                disabled={busy === `box:${m.id}:${h}`}
                                onChange={(e) => void run(`box:${m.id}:${h}`, () => setCalesOnMachine(m.id, h, Number(e.target.value) as 0 | 1 | 2))}
                              >
                                {[0, 1, 2].map((n) => (
                                  <option key={n} value={n}>
                                    {n}
                                  </option>
                                ))}
                              </select>
                            </td>
                          );
                        }
                        const q = qty(m.id, h);
                        return (
                          <td key={h} className="p-1 text-center">
                            <input
                              key={q} // a value saved on the server resets the field
                              type="number"
                              min={0}
                              max={9999}
                              step={1}
                              inputMode="numeric"
                              defaultValue={q}
                              aria-label={`${t('stock.cell', { machine: m.name, h })}${s ? `, ${t(`cales.state.${s}`)}` : ''}`}
                              className={`aurora-input stock-cell ${s ? `s-${s}` : ''}`}
                              disabled={busy === `qty:${m.id}:${h}`}
                              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                              onBlur={(e) => {
                                const el = e.currentTarget;
                                if (el.value === '') el.value = String(q);
                                else if (Number(el.value) !== q) void run(`qty:${m.id}:${h}`, () => setCalesStock(m.id, h, Number(el.value)));
                              }}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
