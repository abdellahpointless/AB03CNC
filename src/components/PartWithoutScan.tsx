import React, { useState, useEffect, useId } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useSync } from '../contexts/SyncContext';
import { PartKind, MonthlySummaryRow } from '../types';
import {
  submitPartEntry,
  fetchUserMonthlySummary,
  fetchMonthApprovedEntries,
  fetchUserApprovedEntriesForExport,
  getDeviceLocalMonthKey,
  validateSapNumber,
  validateQuantity
} from '../lib/partsApi';
import { exportUserPartEntriesExcel } from '../lib/partExportExcel';
import {
  PackagePlus,
  Calendar,
  Layers,
  ChevronDown,
  ChevronUp,
  Download,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  FileSpreadsheet
} from 'lucide-react';

export default function PartWithoutScan() {
  const { user } = useAuth();
  const { versions } = useSync();
  const userId = user?.id || '';
  const username = user?.username || 'Unknown';

  // Form State
  const [sapNumber, setSapNumber] = useState('');
  const [qty, setQty] = useState<number | ''>(1);
  const [kind, setKind] = useState<PartKind>('PRODUCED');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Summary State
  const [summaryRows, setSummaryRows] = useState<MonthlySummaryRow[]>([]);
  const [isLoadingSummary, setIsLoadingSummary] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  // Expanded Month & Entries State
  const [expandedMonth, setExpandedMonth] = useState<string | null>(null);
  const [monthEntries, setMonthEntries] = useState<Record<string, { entries: any[]; page: number; hasMore: boolean; loading: boolean }>>({});

  // Export State
  const [isExporting, setIsExporting] = useState(false);

  // Derived current month key
  const currentMonthKey = getDeviceLocalMonthKey();
  const currentMonthSummary = summaryRows.find(r => r.month_key === currentMonthKey);
  const currentMonthValue = currentMonthSummary ? Number(currentMonthSummary.total_value) : 0;
  const currentMonthQty = currentMonthSummary ? Number(currentMonthSummary.total_qty) : 0;

  // Live calculation for preview
  const numQty = typeof qty === 'number' && qty > 0 ? qty : 0;
  const unitVal = kind === 'PRODUCED' ? 1 : 0.5;
  const previewValue = numQty * unitVal;

  const sapInputId = useId();
  const qtyInputId = useId();

  // Load on mount, and again whenever an admin approves/rejects entries on another PC
  useEffect(() => {
    if (!userId) return;
    let isCancelled = false;

    const loadData = async () => {
      setIsLoadingSummary(true);
      setSummaryError(null);
      const res = await fetchUserMonthlySummary();
      if (!isCancelled) {
        if (res.success) {
          setSummaryRows(res.rows!);
          setMonthEntries({});
          setExpandedMonth(null);
        } else {
          setSummaryError(res.error || 'Failed to load monthly summary');
        }
        setIsLoadingSummary(false);
      }
    };

    loadData();
    return () => {
      isCancelled = true;
    };
  }, [userId, versions.parts]);

  const handleRefreshSummary = async () => {
    if (!userId || isLoadingSummary) return;
    setIsLoadingSummary(true);
    setSummaryError(null);
    const res = await fetchUserMonthlySummary();
    if (res.success) {
      setSummaryRows(res.rows!);
    } else {
      setSummaryError(res.error || 'Failed to refresh monthly summary');
    }
    setIsLoadingSummary(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    setSubmitMessage(null);
    setSubmitError(null);

    const sapVal = validateSapNumber(sapNumber);
    if (!sapVal.isValid) {
      setSubmitError(sapVal.error || 'Invalid SAP number');
      return;
    }

    const qtyVal = validateQuantity(qty);
    if (!qtyVal.isValid) {
      setSubmitError(qtyVal.error || 'Invalid quantity');
      return;
    }

    setIsSubmitting(true);
    const res = await submitPartEntry({
      sapNumber: sapVal.sanitized,
      qty: qtyVal.qty,
      kind
    });

    setIsSubmitting(false);

    if (res.success) {
      // Neutral message only - never disclose approval/rejection state
      setSubmitMessage('Entry submitted');
      setSapNumber('');
      setQty(1);
      setKind('PRODUCED');
      setTimeout(() => setSubmitMessage(null), 4000);
    } else {
      setSubmitError(res.error || 'Submission failed. Please try again.');
    }
  };

  const handleToggleMonth = async (monthKey: string) => {
    if (expandedMonth === monthKey) {
      setExpandedMonth(null);
      return;
    }

    setExpandedMonth(monthKey);

    // If month entries haven't been fetched yet, load page 0
    if (!monthEntries[monthKey]) {
      setMonthEntries(prev => ({
        ...prev,
        [monthKey]: { entries: [], page: 0, hasMore: false, loading: true }
      }));

      const res = await fetchMonthApprovedEntries(monthKey, 0);
      setMonthEntries(prev => ({
        ...prev,
        [monthKey]: {
          entries: res.entries ?? [],
          page: 0,
          hasMore: !!res.hasMore,
          loading: false
        }
      }));
    }
  };

  const handleLoadMoreEntries = async (monthKey: string) => {
    const current = monthEntries[monthKey];
    if (!current || current.loading || !current.hasMore) return;

    const nextPage = current.page + 1;
    setMonthEntries(prev => ({
      ...prev,
      [monthKey]: { ...prev[monthKey], loading: true }
    }));

    const res = await fetchMonthApprovedEntries(monthKey, nextPage);
    setMonthEntries(prev => ({
      ...prev,
      [monthKey]: {
        entries: [...prev[monthKey].entries, ...(res.entries ?? [])],
        page: res.success ? nextPage : current.page,
        hasMore: !!res.hasMore,
        loading: false
      }
    }));
  };

  const handleExportExcel = async () => {
    if (isExporting || !userId) return;
    setIsExporting(true);
    try {
      const entries = await fetchUserApprovedEntriesForExport();
      await exportUserPartEntriesExcel({
        username,
        summaryRows,
        entries
      });
    } catch (err: any) {
      console.error('Export error:', err);
      alert('Failed to generate Excel file: ' + (err?.message || 'Unknown error'));
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="flex flex-col space-y-6 max-w-5xl mx-auto w-full pb-16">
      {/* Header Banner */}
      <div className="glass-panel p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-[var(--radius-md)] bg-[var(--blue-500)]/15 border border-[var(--blue-500)]/30 flex items-center justify-center text-[var(--blue-500)] shrink-0 shadow-xs">
            <PackagePlus size={22} />
          </div>
          <div>
            <h2 className="text-xl font-bold tracking-tight text-[var(--text-primary)]">
              Part without scan
            </h2>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">
              Submit manual production logs and track your approved monthly quantities
            </p>
          </div>
        </div>

        {/* Action button: Export Excel */}
        <div className="flex items-center gap-2.5">
          <button
            onClick={handleExportExcel}
            disabled={isExporting || summaryRows.length === 0}
            className="btn-secondary text-xs py-2 px-3.5 flex items-center gap-2"
            title="Download personal approved records as Excel (.xlsx)"
          >
            {isExporting ? (
              <RefreshCw size={14} className="animate-spin text-[var(--accent-primary)]" />
            ) : (
              <FileSpreadsheet size={15} className="text-[var(--green-500)]" />
            )}
            <span>{isExporting ? 'Generating Excel...' : 'Export Excel'}</span>
          </button>

          <button
            onClick={handleRefreshSummary}
            disabled={isLoadingSummary}
            className="btn-icon"
            title="Refresh summary data"
          >
            <RefreshCw size={15} className={isLoadingSummary ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Main Grid: Submit Form (Left) & This Month's Counter (Right) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Submit Form Card (2 cols) */}
        <div className="lg:col-span-2 aurora-card p-6 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between border-b border-[var(--border-subtle)] pb-3 mb-5">
              <span className="section-label flex items-center gap-2">
                <Layers size={14} className="text-[var(--accent-primary)]" />
                New Production Entry
              </span>
              <span className="text-[11px] font-mono text-[var(--text-tertiary)]">
                Month: {currentMonthKey}
              </span>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {/* SAP Number */}
              <div>
                <label htmlFor={sapInputId} className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5">
                  SAP Number <span className="text-[var(--rose-500)]">*</span>
                </label>
                <input
                  id={sapInputId}
                  type="text"
                  value={sapNumber}
                  onChange={e => setSapNumber(e.target.value.toUpperCase())}
                  placeholder="e.g. 10245-A, P98302_REV2"
                  maxLength={40}
                  disabled={isSubmitting}
                  className="aurora-input w-full font-mono text-xs sm:text-sm tracking-wide uppercase"
                  autoComplete="off"
                />
                <span className="text-[10px] text-[var(--text-tertiary)] mt-1 block">
                  Letters, numbers, hyphens, underscores and dots (max 40 chars)
                </span>
              </div>

              {/* Quantity & Type Side-by-side */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor={qtyInputId} className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5">
                    Quantity <span className="text-[var(--rose-500)]">*</span>
                  </label>
                  <input
                    id={qtyInputId}
                    type="number"
                    min={1}
                    max={9999}
                    step={1}
                    value={qty}
                    onChange={e => {
                      const v = e.target.value;
                      setQty(v === '' ? '' : parseInt(v, 10));
                    }}
                    disabled={isSubmitting}
                    className="aurora-input w-full font-mono text-xs sm:text-sm"
                    placeholder="1"
                  />
                  <span className="text-[10px] text-[var(--text-tertiary)] mt-1 block">
                    Must be between 1 and 9999
                  </span>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-[var(--text-secondary)] mb-1.5">
                    Production Kind
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setKind('PRODUCED')}
                      disabled={isSubmitting}
                      className={`py-2 px-2.5 rounded-[var(--radius-md)] text-xs font-semibold border transition-all text-center cursor-pointer ${
                        kind === 'PRODUCED'
                          ? 'bg-[var(--blue-500)]/20 border-[var(--blue-500)] text-white shadow-xs'
                          : 'bg-[var(--bg-input)] border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      <div>Produced part</div>
                      <div className="text-[10px] opacity-75 font-mono">Value: 1.0</div>
                    </button>

                    <button
                      type="button"
                      onClick={() => setKind('MODIFICATION')}
                      disabled={isSubmitting}
                      className={`py-2 px-2.5 rounded-[var(--radius-md)] text-xs font-semibold border transition-all text-center cursor-pointer ${
                        kind === 'MODIFICATION'
                          ? 'bg-[var(--orange-500)]/20 border-[var(--orange-500)] text-white shadow-xs'
                          : 'bg-[var(--bg-input)] border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      <div>Modification</div>
                      <div className="text-[10px] opacity-75 font-mono">Value: 0.5</div>
                    </button>
                  </div>
                </div>
              </div>

              {/* Live Preview Strip */}
              <div className="bg-[var(--bg-input)] p-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] flex items-center justify-between">
                <span className="text-xs text-[var(--text-secondary)]">Calculated Value:</span>
                <span className="font-mono text-sm font-bold text-[var(--green-500)]">
                  {numQty} × {unitVal} = <span className="text-base text-[var(--text-primary)]">{previewValue.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</span>
                </span>
              </div>

              {/* Status Messages */}
              {submitMessage && (
                <div className="p-3 rounded-[var(--radius-md)] bg-[var(--green-500)]/15 border border-[var(--green-500)]/30 text-[var(--green-500)] text-xs flex items-center gap-2">
                  <CheckCircle2 size={16} className="shrink-0" />
                  <span>{submitMessage}</span>
                </div>
              )}

              {submitError && (
                <div className="p-3 rounded-[var(--radius-md)] bg-[var(--rose-500)]/15 border border-[var(--rose-500)]/30 text-[var(--rose-500)] text-xs flex items-center gap-2">
                  <AlertCircle size={16} className="shrink-0" />
                  <span>{submitError}</span>
                </div>
              )}

              {/* Submit Button */}
              <button
                type="submit"
                disabled={isSubmitting || !sapNumber.trim() || numQty <= 0}
                className="btn-primary w-full py-2.5 text-xs font-bold tracking-wide"
              >
                {isSubmitting ? (
                  <>
                    <RefreshCw size={15} className="animate-spin" />
                    <span>Submitting Entry...</span>
                  </>
                ) : (
                  <>
                    <PackagePlus size={16} />
                    <span>Submit Part Entry</span>
                  </>
                )}
              </button>
            </form>
          </div>
        </div>

        {/* Counter Card (Right Column) */}
        <div className="aurora-card p-6 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between border-b border-[var(--border-subtle)] pb-3 mb-4">
              <span className="section-label flex items-center gap-2">
                <Calendar size={14} className="text-[var(--green-500)]" />
                This Month's Counter
              </span>
              <span className="badge-neutral text-[10px] font-mono">
                {currentMonthKey}
              </span>
            </div>

            <div className="space-y-4 my-4">
              <div>
                <span className="text-xs text-[var(--text-secondary)] block">
                  Total Approved Value
                </span>
                <div className="stat-metric-number text-[var(--green-500)] mt-1">
                  {currentMonthValue.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
                </div>
              </div>

              <div className="pt-3 border-t border-[var(--border-subtle)] flex items-center justify-between text-xs">
                <span className="text-[var(--text-tertiary)]">Parts Produced:</span>
                <span className="font-mono font-bold text-[var(--text-primary)]">
                  {currentMonthQty.toLocaleString()}
                </span>
              </div>
            </div>
          </div>

          <div className="p-3 rounded-[var(--radius-md)] bg-[rgba(255,255,255,0.03)] border border-[var(--border-subtle)] text-[11px] text-[var(--text-secondary)] leading-relaxed mt-4">
            Counter automatically resets to 0 at the start of each calendar month. Previous months remain archived below.
          </div>
        </div>
      </div>

      {/* Monthly History Section */}
      <div className="aurora-card p-6 space-y-4">
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] pb-3">
          <div className="flex items-center gap-2">
            <Calendar size={16} className="text-[var(--accent-primary)]" />
            <h3 className="font-bold text-sm text-[var(--text-primary)]">
              Monthly Production Archive
            </h3>
          </div>
          <span className="text-xs text-[var(--text-tertiary)]">
            {summaryRows.length} {summaryRows.length === 1 ? 'month' : 'months'} tracked
          </span>
        </div>

        {summaryError && (
          <div className="p-3 rounded-[var(--radius-md)] bg-[var(--rose-500)]/15 border border-[var(--rose-500)]/30 text-[var(--rose-500)] text-xs flex items-center gap-2">
            <AlertCircle size={16} className="shrink-0" />
            <span>{summaryError}</span>
          </div>
        )}

        {summaryRows.length === 0 && !isLoadingSummary && (
          <div className="text-center py-10 text-[var(--text-tertiary)] text-xs bg-[var(--bg-input)] rounded-[var(--radius-md)] border border-dashed border-[var(--border-subtle)]">
            No approved entries found for your account yet. Submitted parts will appear here once verified.
          </div>
        )}

        {/* List of Months */}
        <div className="space-y-3">
          {summaryRows.map(row => {
            const isExpanded = expandedMonth === row.month_key;
            const monthData = monthEntries[row.month_key];

            return (
              <div
                key={row.month_key}
                className="border border-[var(--border-subtle)] rounded-[var(--radius-md)] bg-[var(--bg-input)] overflow-hidden transition-all"
              >
                {/* Accordion Row Header */}
                <button
                  type="button"
                  onClick={() => handleToggleMonth(row.month_key)}
                  className="w-full p-4 flex items-center justify-between text-left hover:bg-[rgba(255,255,255,0.02)] transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="font-mono text-sm font-bold text-[var(--text-primary)]">
                      {row.month_key}
                    </span>
                    {row.month_key === currentMonthKey && (
                      <span className="badge-positive text-[10px] py-0.5 px-2">
                        Current Month
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-4 text-xs shrink-0">
                    <span className="text-[var(--text-secondary)] hidden sm:inline">
                      Parts: <strong className="text-[var(--text-primary)] font-mono">{row.total_qty.toLocaleString()}</strong>
                    </span>
                    <span className="text-[var(--text-secondary)]">
                      Value: <strong className="text-[var(--green-500)] font-mono">{Number(row.total_value).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</strong>
                    </span>
                    {isExpanded ? (
                      <ChevronUp size={16} className="text-[var(--text-tertiary)]" />
                    ) : (
                      <ChevronDown size={16} className="text-[var(--text-tertiary)]" />
                    )}
                  </div>
                </button>

                {/* Accordion Detail Table (Approved Entries Only) */}
                {isExpanded && (
                  <div className="border-t border-[var(--border-subtle)] p-4 bg-[var(--bg-card)] space-y-3">
                    {monthData?.loading && monthData.entries.length === 0 ? (
                      <div className="py-6 flex items-center justify-center gap-2 text-xs text-[var(--text-tertiary)]">
                        <RefreshCw size={14} className="animate-spin" />
                        <span>Loading month records...</span>
                      </div>
                    ) : monthData?.entries && monthData.entries.length > 0 ? (
                      <>
                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-xs">
                            <thead>
                              <tr className="border-b border-[var(--border-subtle)] text-[var(--text-tertiary)] uppercase text-[10px] tracking-wider">
                                <th className="pb-2 font-semibold">Date &amp; Time</th>
                                <th className="pb-2 font-semibold">SAP Number</th>
                                <th className="pb-2 font-semibold">Type</th>
                                <th className="pb-2 font-semibold text-right">Quantity</th>
                                <th className="pb-2 font-semibold text-right">Unit Value</th>
                                <th className="pb-2 font-semibold text-right">Line Value</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-[var(--border-subtle)] font-mono">
                              {monthData.entries.map((entry: any) => {
                                const lineVal = Number(entry.qty || 0) * Number(entry.unit_value || 0);
                                return (
                                  <tr key={entry.id} className="hover:bg-[rgba(255,255,255,0.02)]">
                                    <td className="py-2.5 text-[var(--text-secondary)]">
                                      {new Date(entry.created_at).toLocaleString()}
                                    </td>
                                    <td className="py-2.5 font-bold text-[var(--text-primary)]">
                                      {entry.sap_number}
                                    </td>
                                    <td className="py-2.5 font-sans">
                                      <span className={entry.kind === 'PRODUCED' ? 'badge-neutral text-[10px]' : 'badge-warning text-[10px]'}>
                                        {entry.kind === 'PRODUCED' ? 'Produced' : 'Modification'}
                                      </span>
                                    </td>
                                    <td className="py-2.5 text-right text-[var(--text-primary)] font-semibold">
                                      {entry.qty}
                                    </td>
                                    <td className="py-2.5 text-right text-[var(--text-tertiary)]">
                                      {entry.unit_value}
                                    </td>
                                    <td className="py-2.5 text-right text-[var(--green-500)] font-bold">
                                      {lineVal.toFixed(1)}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>

                        {monthData.hasMore && (
                          <div className="pt-2 flex justify-center">
                            <button
                              type="button"
                              onClick={() => handleLoadMoreEntries(row.month_key)}
                              disabled={monthData.loading}
                              className="btn-secondary text-xs py-1.5 px-4 flex items-center gap-2"
                            >
                              {monthData.loading && <RefreshCw size={12} className="animate-spin" />}
                              <span>Load more entries</span>
                            </button>
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="py-4 text-center text-xs text-[var(--text-tertiary)]">
                        No approved entries found for this month.
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
