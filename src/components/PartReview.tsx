import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useSync } from '../contexts/SyncContext';
import { PartEntry, MonthlySummaryRow } from '../types';
import {
  fetchPendingEntries,
  reviewPartEntries,
  fetchAdminMonthlySummary,
  fetchAdminEntriesForExport
} from '../lib/partsApi';
import { exportAdminPartEntriesExcel } from '../lib/partExportExcel';
import PartProduction from './PartProduction';
import { useT } from '../i18n';
import { fmtDateTime, locale } from '../i18n/format';
import {
  ClipboardCheck,
  Check,
  X,
  RefreshCw,
  FileSpreadsheet,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  User,
  Filter,
  AlertCircle
} from 'lucide-react';

/** Display only: a value with one decimal in the page's language (12.5 / 12,5). */
function fmtValue(n: number): string {
  return n.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false });
}

export default function PartReview() {
  const { t } = useT('parts');
  useAuth();
  const { versions } = useSync();

  // Pending Entries State
  const [entries, setEntries] = useState<PartEntry[]>([]);
  const [page, setPage] = useState<number>(0);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [actionInProgressId, setActionInProgressId] = useState<string | null>(null);
  const [isBulkApproving, setIsBulkApproving] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Admin Export State
  const [exportMonthFilter, setExportMonthFilter] = useState<string>('');
  const [isExporting, setIsExporting] = useState<boolean>(false);

  const [reloadKey, setReloadKey] = useState(0);

  // Fetch the pending list for the current page; new submissions from other PCs appear automatically
  useEffect(() => {
    let isCancelled = false;

    const loadData = async () => {
      setIsLoading(true);
      const res = await fetchPendingEntries(page);
      if (!isCancelled) {
        if (res.success) {
          setEntries(res.entries!);
          setHasMore(!!res.hasMore);
          if (res.entries!.length === 0 && page > 0) setPage(p => Math.max(0, p - 1));
        } else {
          setErrorMsg(res.error || t('review.errors.fetchFailed'));
        }
        setIsLoading(false);
      }
    };

    loadData();
    return () => {
      isCancelled = true;
    };
  }, [page, versions.parts, reloadKey]);

  const handleRefresh = () => {
    if (isLoading) return;
    setErrorMsg(null);
    setReloadKey(k => k + 1);
  };

  const handleApprove = async (entry: PartEntry) => {
    if (actionInProgressId || isBulkApproving) return;
    setActionInProgressId(entry.id);
    setErrorMsg(null);

    const res = await reviewPartEntries([entry.id], 'APPROVED');
    setActionInProgressId(null);

    if (res.success) {
      // Remove row immediately from local state without refetching everything
      setEntries(prev => prev.filter(e => e.id !== entry.id));
    } else {
      setErrorMsg(res.error || t('review.errors.approveFailed', { sap: entry.sap_number }));
    }
  };

  const handleReject = async (entry: PartEntry) => {
    if (actionInProgressId || isBulkApproving) return;
    setActionInProgressId(entry.id);
    setErrorMsg(null);

    const res = await reviewPartEntries([entry.id], 'REJECTED');
    setActionInProgressId(null);

    if (res.success) {
      // Remove row immediately from local state without refetching everything
      setEntries(prev => prev.filter(e => e.id !== entry.id));
    } else {
      setErrorMsg(res.error || t('review.errors.rejectFailed', { sap: entry.sap_number }));
    }
  };

  const handleApproveAllOnPage = async () => {
    if (isBulkApproving || actionInProgressId || entries.length === 0) return;
    const ids = entries.map(e => e.id);

    setIsBulkApproving(true);
    setErrorMsg(null);

    const res = await reviewPartEntries(ids, 'APPROVED');
    setIsBulkApproving(false);

    if (res.success) {
      // Remove the approved rows, then load whatever is still waiting
      setEntries([]);
      setReloadKey(k => k + 1);
    } else {
      setErrorMsg(res.error || t('review.errors.approveAllFailed'));
    }
  };

  const handleExportAdminExcel = async () => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const summaryRes = await fetchAdminMonthlySummary(exportMonthFilter || undefined);
      if (!summaryRes.success) throw new Error(summaryRes.error);
      const allEntries = await fetchAdminEntriesForExport(exportMonthFilter || undefined);

      await exportAdminPartEntriesExcel({
        monthFilter: exportMonthFilter || undefined,
        summaryRows: summaryRes.rows!,
        entries: allEntries
      });
    } catch (err: any) {
      console.error('Admin export error:', err);
      alert(t('review.errors.exportFailed', { message: err?.message || t('errors.unknown') }));
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="flex flex-col space-y-6 max-w-6xl mx-auto w-full pb-16">
      {/* Top Banner */}
      <div className="glass-panel p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-[var(--radius-md)] bg-[var(--green-500)]/15 border border-[var(--green-500)]/30 flex items-center justify-center text-[var(--green-500)] shrink-0 shadow-xs">
            <ClipboardCheck size={22} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-bold tracking-tight text-[var(--text-primary)]">
                {t('review.title')}
              </h2>
              <span className="badge-warning text-[10px] py-0.5 px-2 font-mono">
                {t('review.adminBadge')}
              </span>
            </div>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">
              {t('review.subtitle')}
            </p>
          </div>
        </div>

        {/* Top Controls: Month Filter + Admin Excel Export + Refresh */}
        <div className="flex items-center gap-2.5 flex-wrap">
          <div className="flex items-center gap-1.5 bg-[var(--bg-input)] px-2.5 py-1.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] text-xs">
            <Filter size={13} className="text-[var(--text-tertiary)]" />
            <input
              type="month"
              title={t('review.monthFilterTitle')}
              aria-label={t('review.monthFilterTitle')}
              value={exportMonthFilter}
              onChange={e => setExportMonthFilter(e.target.value.trim())}
              className="bg-transparent border-none outline-none font-mono text-xs text-[var(--text-primary)] w-36"
            />
            {exportMonthFilter && (
              <button type="button" onClick={() => setExportMonthFilter('')} className="no-glass text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" title={t('review.clearMonthFilter')}>✕</button>
            )}
          </div>

          <button
            onClick={handleExportAdminExcel}
            disabled={isExporting}
            className="btn-secondary text-xs py-2 px-3 flex items-center gap-2"
            title={t('review.exportTitle')}
          >
            {isExporting ? (
              <RefreshCw size={14} className="animate-spin text-[var(--accent-primary)]" />
            ) : (
              <FileSpreadsheet size={15} className="text-[var(--green-500)]" />
            )}
            <span>{isExporting ? t('review.exporting') : t('review.exportAll')}</span>
          </button>

          <button
            onClick={handleRefresh}
            disabled={isLoading}
            className="btn-icon"
            title={t('review.refreshTitle')}
          >
            <RefreshCw size={15} className={isLoading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Error Alert */}
      {errorMsg && (
        <div className="p-3 rounded-[var(--radius-md)] bg-[var(--rose-500)]/15 border border-[var(--rose-500)]/30 text-[var(--rose-500)] text-xs flex items-center gap-2">
          <AlertCircle size={16} className="shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* How much each operator produced this month (no Excel needed) */}
      <PartProduction />

      {/* Main Review Card */}
      <div className="aurora-card p-6 space-y-4">
        {/* Table Action Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[var(--border-subtle)] pb-4">
          <div className="flex items-center gap-2">
            <span className="section-label">{t('review.queueTitle')}</span>
            <span className="badge-neutral text-[10px] py-0 px-2 font-mono">
              {t('review.pageItems', { page: page + 1, items: entries.length })}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleApproveAllOnPage}
              disabled={isBulkApproving || actionInProgressId !== null || entries.length === 0}
              className="btn-success text-xs py-1.5 px-3 flex items-center gap-1.5"
              title={t('review.approveAllTitle')}
            >
              <CheckCheck size={14} />
              <span>{isBulkApproving ? t('review.approvingPage') : t('review.approveAll')}</span>
            </button>
          </div>
        </div>

        {/* Loading Indicator */}
        {isLoading && entries.length === 0 && (
          <div className="py-16 text-center text-xs text-[var(--text-tertiary)] flex flex-col items-center gap-2">
            <RefreshCw size={18} className="animate-spin text-[var(--accent-primary)]" />
            <span>{t('review.loading')}</span>
          </div>
        )}

        {/* Empty State */}
        {!isLoading && entries.length === 0 && (
          <div className="text-center py-16 text-[var(--text-tertiary)] bg-[var(--bg-input)] rounded-[var(--radius-md)] border border-dashed border-[var(--border-subtle)]">
            <ClipboardCheck size={36} className="mx-auto mb-2 opacity-30 text-[var(--green-500)]" />
            <p className="text-sm font-semibold text-[var(--text-secondary)]">{t('review.emptyTitle')}</p>
            <p className="text-xs text-[var(--text-tertiary)] mt-0.5">
              {t('review.emptyText')}
            </p>
          </div>
        )}

        {/* Table of Entries */}
        {entries.length > 0 && (
          <div className="overflow-x-auto">
            {/* Space between columns (QTY | KIND and VALUE | DATE used to touch). */}
            <table className="w-full text-left text-xs [&_th]:px-3 [&_td]:px-3 [&_th:first-child]:pl-0 [&_td:first-child]:pl-0 [&_th:last-child]:pr-0 [&_td:last-child]:pr-0">
              <thead>
                <tr className="border-b border-[var(--border-subtle)] text-[var(--text-tertiary)] uppercase text-[10px] tracking-wider">
                  <th className="pb-2.5 font-semibold">{t('review.columns.operator')}</th>
                  <th className="pb-2.5 font-semibold">{t('review.columns.sapNumber')}</th>
                  <th className="pb-2.5 font-semibold text-right">{t('review.columns.qty')}</th>
                  <th className="pb-2.5 font-semibold">{t('review.columns.kind')}</th>
                  <th className="pb-2.5 font-semibold text-right">{t('review.columns.value')}</th>
                  <th className="pb-2.5 font-semibold">{t('review.columns.submittedDate')}</th>
                  <th className="pb-2.5 font-semibold text-right">{t('review.columns.action')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)] font-mono">
                {entries.map((entry, entryIdx) => {
                  const lineValue = Number(entry.qty || 0) * Number(entry.unit_value || 0);
                  const isBusy = actionInProgressId === entry.id || isBulkApproving;

                  return (
                    <tr key={entry.id} style={{ '--i': entryIdx } as React.CSSProperties} className="wave-in hover:bg-[rgba(var(--ov),0.02)] transition-colors">
                      {/* Operator */}
                      <td className="py-3 font-sans">
                        <span className="flex items-center gap-1.5 font-semibold text-[var(--text-primary)]">
                          <User size={13} className="text-[var(--accent-primary)]" />
                          {entry.username}
                        </span>
                      </td>

                      {/* SAP Number */}
                      <td className="py-3 font-bold text-[var(--text-primary)]">
                        {entry.sap_number}
                      </td>

                      {/* Qty */}
                      <td className="py-3 text-right font-semibold text-[var(--text-primary)]">
                        {entry.qty}
                      </td>

                      {/* Kind */}
                      <td className="py-3 font-sans">
                        <span className={entry.kind === 'PRODUCED' ? 'badge-neutral text-[10px]' : 'badge-warning text-[10px]'}>
                          {entry.kind === 'PRODUCED' ? t('kind.PRODUCED') : t('kind.MODIFICATION')}
                        </span>
                      </td>

                      {/* Value */}
                      <td className="py-3 text-right text-[var(--green-500)] font-bold">
                        {fmtValue(lineValue)}
                      </td>

                      {/* Date */}
                      <td className="py-3 text-[var(--text-secondary)] font-sans text-[11px]">
                        {fmtDateTime(entry.created_at)}
                      </td>

                      {/* Actions */}
                      <td className="py-3 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleApprove(entry)}
                            disabled={isBusy}
                            className="btn-success text-xs py-1 px-2.5 flex items-center gap-1"
                            title={t('review.approveTitle')}
                          >
                            <Check size={13} />
                            <span>{t('review.approve')}</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => handleReject(entry)}
                            disabled={isBusy}
                            className="btn-secondary text-xs py-1 px-2 flex items-center gap-1 hover:border-[var(--rose-500)] hover:text-[var(--rose-500)]"
                            title={t('review.rejectTitle')}
                          >
                            <X size={13} />
                            <span>{t('review.reject')}</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination Footer */}
        <div className="flex items-center justify-between border-t border-[var(--border-subtle)] pt-4 text-xs">
          <span className="text-[var(--text-tertiary)]">
            {t('review.footer')}
          </span>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0 || isLoading}
              className="btn-secondary text-xs py-1 px-2.5 flex items-center gap-1"
            >
              <ChevronLeft size={14} />
              <span>{t('review.previous')}</span>
            </button>

            <span className="font-mono text-xs text-[var(--text-secondary)] px-2">
              {t('review.page', { page: page + 1 })}
            </span>

            <button
              onClick={() => setPage(p => p + 1)}
              disabled={!hasMore || isLoading}
              className="btn-secondary text-xs py-1 px-2.5 flex items-center gap-1"
            >
              <span>{t('review.next')}</span>
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
