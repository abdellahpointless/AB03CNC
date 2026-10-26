import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { BarChart3, Clock, RefreshCw } from 'lucide-react';
import { useSync } from '../contexts/SyncContext';
import { fetchAdminProduction, type OperatorProduction, type PartsPeriod } from '../lib/partsApi';
import { useT } from '../i18n';
import { fmtDate, locale } from '../i18n/format';

/** Display only: a value with one decimal in the page's language (12.5 / 12,5). */
const fmtValue = (n: number) => n.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false });
const fmtQty = (n: number) => n.toLocaleString(locale());

/** "26/09/2026 → 26/10/2026" in the page's date format. */
const periodLabel = (p: PartsPeriod) => `${fmtDate(`${p.from}T00:00`)} → ${fmtDate(`${p.to}T00:00`)}`;

/**
 * Part review, top card: how much each operator produced this month, at a glance, without
 * downloading the Excel file. Approved entries only; what still waits for review is shown apart.
 */
export default function PartProduction({ period }: { period: PartsPeriod }) {
  const { t } = useT('parts');
  const { versions } = useSync();
  const [rows, setRows] = useState<OperatorProduction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Reloads by itself when entries are submitted or reviewed (on this PC or another).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchAdminProduction(period).then((res) => {
      if (cancelled) return;
      if (res.success) {
        setRows(res.rows);
        setError(null);
      } else {
        setError(res.error);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [period, versions.parts]);

  const totals = useMemo(() => {
    const parts = rows.reduce((n, r) => n + r.produced_qty + r.modification_qty, 0);
    const value = rows.reduce((n, r) => n + r.total_value, 0);
    const waiting = rows.reduce((n, r) => n + r.pending_qty, 0);
    const operators = rows.filter((r) => r.produced_qty + r.modification_qty > 0).length;
    const best = Math.max(0, ...rows.map((r) => r.total_value));
    return { parts, value, waiting, operators, best };
  }, [rows]);

  return (
    <div className="aurora-card aurora-card-static p-6 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[var(--border-subtle)] pb-4">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-[var(--radius-md)] bg-[var(--accent-primary)]/12 border border-[var(--accent-primary)]/25 flex items-center justify-center text-[var(--accent-primary)] shrink-0">
            <BarChart3 size={16} />
          </div>
          <div className="min-w-0">
            <div className="section-label">{t('production.title')}</div>
            <p className="text-xs text-[var(--text-tertiary)] mt-0.5">{t('production.subtitle')}</p>
          </div>
        </div>

        <span className="text-xs font-semibold text-[var(--text-primary)] tabular-nums self-start sm:self-auto">{periodLabel(period)}</span>
      </div>

      {error && <div className="text-xs text-[var(--rose-500)]">{t('production.failed', { message: error })}</div>}

      {loading && rows.length === 0 && !error && (
        <div className="py-8 text-center text-xs text-[var(--text-tertiary)] flex items-center justify-center gap-2">
          <RefreshCw size={14} className="animate-spin text-[var(--accent-primary)]" />
          <span>{t('production.loading')}</span>
        </div>
      )}

      {!loading && rows.length === 0 && !error && (
        <div className="py-8 text-center text-xs text-[var(--text-tertiary)] bg-[var(--bg-input)] rounded-[var(--radius-md)] border border-dashed border-[var(--border-subtle)]">
          {t('production.empty', { month: periodLabel(period) })}
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-secondary)]">
            <span>{t('production.operators', { count: totals.operators })}</span>
            <span className="text-[var(--text-tertiary)]">·</span>
            <span className="font-semibold text-[var(--text-primary)]">{t('production.partsApproved', { count: totals.parts, qty: fmtQty(totals.parts) })}</span>
            <span className="text-[var(--text-tertiary)]">·</span>
            <span>{t('production.totalValue', { value: fmtValue(totals.value) })}</span>
            {totals.waiting > 0 && (
              <>
                <span className="text-[var(--text-tertiary)]">·</span>
                <span className="inline-flex items-center gap-1 text-[var(--orange-text)]">
                  <Clock size={11} />
                  {t('production.waitingTotal', { count: totals.waiting, qty: fmtQty(totals.waiting) })}
                </span>
              </>
            )}
          </div>

          <ul className={`space-y-1 transition-opacity duration-200 ${loading ? 'opacity-60' : ''}`}>
            {rows.map((r, i) => {
              const share = totals.best > 0 ? r.total_value / totals.best : 0;
              return (
                <li
                  key={r.user_id}
                  style={{ '--i': i } as React.CSSProperties}
                  className="wave-in grid grid-cols-[auto_minmax(0,1fr)_auto] sm:grid-cols-[auto_minmax(7rem,12rem)_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-2.5 py-2 rounded-[var(--radius-md)] hover:bg-[rgba(var(--ov),0.035)] transition-colors"
                >
                  <span className="w-7 h-7 rounded-full bg-[var(--accent-primary)]/14 border border-[var(--accent-primary)]/25 text-[var(--accent-primary)] text-xs font-bold uppercase flex items-center justify-center">
                    {r.username.slice(0, 2)}
                  </span>
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-[var(--text-primary)] truncate">{r.username}</div>
                    <div className="text-xs text-[var(--text-tertiary)] truncate">
                      {t('production.produced', { qty: fmtQty(r.produced_qty) })}
                      {r.modification_qty > 0 && <> · {t('production.modified', { qty: fmtQty(r.modification_qty) })}</>}
                    </div>
                  </div>
                  <div className="hidden sm:block h-2 rounded-full bg-[rgba(var(--ov),0.06)] overflow-hidden" aria-hidden="true">
                    <motion.div
                      className="h-full rounded-full bg-[var(--accent-primary)]"
                      initial={{ width: 0 }}
                      animate={{ width: `${Math.max(share * 100, r.total_value > 0 ? 2 : 0)}%` }}
                      transition={{ type: 'spring', duration: 0.5, bounce: 0 }}
                    />
                  </div>
                  <div className="text-right whitespace-nowrap">
                    <div className="text-sm font-bold font-mono text-[var(--green-500)] tabular-nums">{fmtValue(r.total_value)}</div>
                    {r.pending_qty > 0 ? (
                      <div className="text-xs text-[var(--orange-text)]" title={t('production.waitingTitle')}>
                        {t('production.waiting', { qty: fmtQty(r.pending_qty) })}
                      </div>
                    ) : (
                      <div className="text-xs text-[var(--text-tertiary)]">{t('production.value')}</div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
