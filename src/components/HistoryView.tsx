import React, { useEffect, useRef, useState } from 'react';
import { HistoryRecord } from '../types';
import { Clock, FileText, User, Bot, Download, Eye, Search, Filter, X, Copy, Check, Cpu, ChevronDown, ChevronLeft, ChevronRight, Archive, RefreshCw, AlertTriangle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { TimeWonClock } from './TimeWonClock';
import { applyG53BeforeG52 } from '../lib/gcodeProcessor';
import { api } from '../lib/api';
import { fetchAllHistory, fetchHistoryPage, fetchRecordCode } from '../lib/historyApi';
import { downloadJson, downloadText, todayStamp } from '../lib/download';
import { useSync } from '../contexts/SyncContext';
import { csvCell, csvDialect } from '../lib/csv';
import { machineName } from '../lib/machines';
import { waveItem, EASE_OUT, EXIT_FAST, FADE, SPRING_MODAL, SPRING_POP, iosBackdrop, iosSurface } from '../lib/motion';
import i18n, { useT } from '../i18n';
import { fmtDateTime } from '../i18n/format';

const PAGE_SIZE = 10;

/** Display name of a tool category id (the id itself stays the data value). */
function categoryLabel(id: string): string {
  const key = `common:category.${id}`;
  return id && i18n.exists(key) ? i18n.t(key as 'common:category.foret') : id;
}

export function historyToCsv(records: HistoryRecord[], machineLabel: (id: string) => string = (id) => id): string {
  const t = i18n.t.bind(i18n);
  const headers = [
    t('history:csv.date'), t('history:csv.operator'), t('history:csv.machine'), t('history:csv.originalFile'),
    t('history:csv.exportedFile'), t('history:csv.originalTool'), t('history:csv.originalContext'),
    t('history:csv.requestedDiameter'), t('history:csv.requestedLength'), t('history:csv.selectionType'),
    t('history:csv.chosenCategory'), t('history:csv.chosenTNumber'), t('history:csv.chosenDiameter'),
    t('history:csv.chosenLength'),
  ];
  const { sep, num } = csvDialect(i18n.language);
  const rows = [headers.join(sep)];
  for (const record of records) {
    const base = [record.date, record.user || t('history:shared.unknownUser'), (record.machine && machineLabel(record.machine)) || '-', record.originalFileName, record.exportedFileName];
    if (!record.changes.length) {
      rows.push([...base, '-', '-', '-', '-', '-', '-', '-', '-', '-'].map(csvCell).join(sep));
      continue;
    }
    for (const change of record.changes) {
      rows.push([
        ...base,
        change.originalT,
        change.originalContext || '',
        num(change.reqDiameter ?? ''),
        num(change.reqLength ?? ''),
        change.appChose ? t('history:csv.auto') : t('history:csv.manual'),
        categoryLabel(change.chosenCategory),
        `T${change.chosenT}`,
        num(change.chosenDiameter),
        num(change.chosenLength),
      ].map(csvCell).join(sep));
    }
  }
  return rows.join('\n');
}

export default function HistoryView() {
  const { t } = useT('history');
  const { versions, machines } = useSync();
  const machineLabel = (id: string) => machineName(machines, id);
  const [selectedUser, setSelectedUser] = useState<string>('ALL');
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [debouncedSearch, setDebouncedSearch] = useState<string>('');
  const [inspectingRecord, setInspectingRecord] = useState<HistoryRecord | null>(null);
  const [inspectCode, setInspectCode] = useState<string>('');
  const [isLoadingCode, setIsLoadingCode] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [busyAction, setBusyAction] = useState<string | null>(null);

  // Server-side pagination in batches of 10
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [paginatedRecords, setPaginatedRecords] = useState<HistoryRecord[]>([]);
  const [totalRecords, setTotalRecords] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [userCounts, setUserCounts] = useState<{ username: string; count: number }[]>([]);
  const lastCountsFetch = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchTerm.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  // Load the visible page (and refresh it when another PC exports a program)
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    fetchHistoryPage({
      limit: PAGE_SIZE,
      offset: (currentPage - 1) * PAGE_SIZE,
      user: selectedUser === 'ALL' ? undefined : selectedUser,
      q: debouncedSearch || undefined,
    })
      .then(res => {
        if (cancelled) return;
        setPaginatedRecords(res.records);
        setTotalRecords(res.total);
        setLoadError(null);
        const pages = Math.max(1, Math.ceil(res.total / PAGE_SIZE));
        if (currentPage > pages) setCurrentPage(pages);
      })
      .catch(err => {
        if (!cancelled) setLoadError(err?.message || t('view.errors.loadFailed'));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentPage, selectedUser, debouncedSearch, versions.history]);

  // Per-operator counts for the filter (refreshed at most once a minute to save database reads)
  useEffect(() => {
    if (Date.now() - lastCountsFetch.current < 60_000 && userCounts.length) return;
    lastCountsFetch.current = Date.now();
    api<{ users: { username: string; count: number }[] }>('/history/users')
      .then(res => setUserCounts(res.users))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versions.history]);

  const grandTotal = userCounts.reduce((acc, u) => acc + u.count, 0) || (selectedUser === 'ALL' && !debouncedSearch ? totalRecords : 0);
  const allUsers = userCounts.map(u => u.username);

  const handleUserChange = (u: string) => {
    setSelectedUser(u);
    setCurrentPage(1);
  };

  const handleSearchChange = (term: string) => {
    setSearchTerm(term);
    setCurrentPage(1);
  };

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const totalPages = Math.max(1, Math.ceil(totalRecords / PAGE_SIZE));
  const safeCurrentPage = Math.min(Math.max(1, currentPage), totalPages);
  const startIndex = (safeCurrentPage - 1) * PAGE_SIZE;
  const endIndex = Math.min(startIndex + paginatedRecords.length, totalRecords);
  const filteredCount = totalRecords;

  const handleExpandAll = () => {
    setExpandedIds(new Set(paginatedRecords.map(r => r.id)));
  };

  const handleCollapseAll = () => {
    setExpandedIds(new Set());
  };

  const handleInspect = async (record: HistoryRecord) => {
    setInspectingRecord(record);
    setIsLoadingCode(true);
    setInspectCode('');
    setCopied(false);

    try {
      const code = await fetchRecordCode(record.id);
      const { lines: safeLines } = applyG53BeforeG52(code.split('\n'));
      setInspectCode(safeLines.join('\n'));
    } catch (err: any) {
      setInspectCode('; ' + (err?.message || t('view.errors.codeNotRetrieved')));
    } finally {
      setIsLoadingCode(false);
    }
  };

  const handleDownloadCode = async (record: HistoryRecord) => {
    setDownloadingId(record.id);
    try {
      const code = await fetchRecordCode(record.id);
      const { lines: safeLines } = applyG53BeforeG52(code.split('\n'));
      downloadText(record.exportedFileName, safeLines.join('\n'));
    } catch (e: any) {
      alert(e?.message || t('shared.codeUnavailable'));
    } finally {
      setDownloadingId(null);
    }
  };

  const handleCopyCode = async () => {
    if (!inspectCode) return;
    try {
      await navigator.clipboard.writeText(inspectCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      alert(t('view.errors.copyFailed'));
    }
  };

  const exportToCSV = async () => {
    setBusyAction('csv');
    try {
      const all = await fetchAllHistory();
      if (!all.length) return;
      // newest first, like the screen
      downloadText(`tool_history_report_${todayStamp()}.csv`, '﻿' + historyToCsv([...all].reverse(), machineLabel), 'text/csv;charset=utf-8');
    } catch (err: any) {
      alert(t('view.errors.csvFailed', { message: err?.message || String(err) }));
    } finally {
      setBusyAction(null);
    }
  };

  const archiveOlderThan30Days = async () => {
    if (!confirm(t('view.confirm.archive'))) return;
    setBusyAction('archive');
    try {
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const old = (await fetchAllHistory()).filter(r => (r.timestamp ?? 0) < cutoff);
      if (!old.length) {
        alert(t('view.alerts.nothingToArchive'));
        return;
      }
      downloadJson(`CNC_History_Archive_${todayStamp()}.json`, {
        archivedAt: new Date().toISOString(),
        reason: 'Archive & Prune >30 Days from History View',
        historyCount: old.length,
        history: [...old].reverse(),
      });
      const res = await api<{ deleted: number }>('/history/prune', { method: 'POST', body: { olderThanDays: 30 } });
      alert(t('view.alerts.archiveDone', { count: res.deleted }));
    } catch (err: any) {
      alert(t('view.errors.archiveFailed', { message: err?.message || String(err) }));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="flex flex-col h-full space-y-4 max-w-7xl mx-auto w-full pb-12">
      {/* Header Panel */}
      <div className="glass-panel p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-[var(--radius-md)] bg-[var(--orange-500)]/15 border border-[var(--orange-500)]/30 text-[var(--orange-500)]">
              <Clock size={20} />
            </div>
            <h2 className="text-xl font-bold text-[var(--text-primary)]">
              {t('view.title')}
            </h2>
          </div>
          <p className="text-xs text-[var(--text-secondary)] mt-1.5 pl-1">
            {t('view.subtitle')}
          </p>
        </div>
        
        <div className="flex items-center gap-2.5 self-start sm:self-auto flex-wrap">
          <TimeWonClock compact={true} />
          {grandTotal > 0 && (
            <>
              <button 
                onClick={exportToCSV}
                disabled={busyAction !== null}
                className="btn-success text-xs py-2 px-3.5 whitespace-nowrap"
                title={t('view.exportCsvTitle')}
              >
                {busyAction === 'csv' ? <RefreshCw size={14} className="animate-spin" /> : <Download size={14} />}
                <span>{t('view.exportCsv')}</span>
              </button>

              <button
                onClick={archiveOlderThan30Days}
                disabled={busyAction !== null}
                className="btn-secondary text-xs py-2 px-3 whitespace-nowrap text-[var(--orange-500)] border-[var(--orange-500)]/40 hover:bg-[var(--orange-500)]/10"
                title={t('view.archiveTitle')}
              >
                {busyAction === 'archive' ? <RefreshCw size={14} className="animate-spin" /> : <Archive size={14} />}
                <span>{t('view.archive')}</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Filter, Search & Compact Pagination Bar */}
      {loadError && (
        <div className="badge-danger w-full py-2 px-3 text-xs">
          <AlertTriangle size={14} className="shrink-0" />
          <span>{loadError}</span>
        </div>
      )}

      {(grandTotal > 0 || selectedUser !== 'ALL' || debouncedSearch) && (
        <div className="glass-panel p-3 space-y-2.5">
          <div className="flex flex-col md:flex-row gap-2.5 items-stretch md:items-center justify-between">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" size={15} />
              <input
                type="text"
                value={searchTerm}
                onChange={e => handleSearchChange(e.target.value)}
                placeholder={t('view.searchPlaceholder')}
                className="aurora-input w-full pl-9 py-1.5 text-xs"
              />
            </div>

            <div className="flex items-center gap-2 shrink-0 flex-wrap">
              <Filter size={13} className="text-[var(--text-tertiary)]" />
              <span className="text-[11px] text-[var(--text-secondary)] font-medium">{t('view.operatorFilter')}</span>
              <select
                value={selectedUser}
                onChange={e => handleUserChange(e.target.value)}
                className="aurora-input text-xs py-1 px-2.5 cursor-pointer max-w-[170px]"
              >
                <option value="ALL" className="bg-[var(--bg-panel)]">{t('view.allOption', { total: grandTotal })}</option>
                {allUsers.map(u => (
                  <option key={u} value={u} className="bg-[var(--bg-panel)]">
                    {u} ({userCounts.find(c => c.username === u)?.count ?? 0})
                  </option>
                ))}
              </select>

              <div className="flex items-center gap-1 border-l border-[var(--border-subtle)] pl-2">
                <button
                  onClick={handleExpandAll}
                  className="btn-secondary text-[10px] py-1 px-2"
                  title={t('view.expandTitle')}
                >
                  {t('view.expand')}
                </button>
                <button
                  onClick={handleCollapseAll}
                  className="btn-secondary text-[10px] py-1 px-2"
                  title={t('view.collapseTitle')}
                >
                  {t('view.collapse')}
                </button>
              </div>
            </div>
          </div>

          {/* Compact Inline Pagination Strip */}
          {filteredCount > 0 && (
            <div className="pt-2 border-t border-[var(--border-subtle)] flex items-center justify-between gap-2 text-[11px]">
              <div className="text-[var(--text-secondary)] font-medium flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-primary)]" />
                <span>{t('view.records')}</span>
                <span className="font-mono font-bold text-[var(--text-primary)]">
                  {startIndex + 1}–{endIndex}
                </span>
                <span className="text-[var(--text-tertiary)]">{t('view.of')}</span>
                <span className="font-mono font-bold text-[var(--accent-primary)]">
                  {totalRecords}
                </span>
                {selectedUser !== 'ALL' && (
                  <span className="badge-neutral text-[10px] py-0 px-1.5 ml-1">
                    {selectedUser}
                  </span>
                )}
              </div>

              {totalPages > 1 && (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={safeCurrentPage === 1}
                    className="btn-icon w-6 h-6 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                    title={t('view.previousPage')}
                  >
                    <ChevronLeft size={13} />
                  </button>

                  <div className="flex items-center gap-1 px-1">
                    {pageWindow(totalPages, safeCurrentPage).map(page => {
                      const isCur = page === safeCurrentPage;
                      return (
                        <button
                          key={page}
                          onClick={() => setCurrentPage(page)}
                          className={`min-w-6 h-6 px-1.5 text-[11px] rounded-[var(--radius-sm)] font-mono transition cursor-pointer ${
                            isCur
                              ? 'bg-[var(--accent-primary)] text-white font-bold shadow-xs'
                              : 'text-[var(--text-secondary)] hover:bg-[rgba(var(--ov),0.06)]'
                          }`}
                          title={t('view.pageButtonTitle', { page, start: (page - 1) * PAGE_SIZE + 1, end: Math.min(page * PAGE_SIZE, totalRecords) })}
                        >
                          {page}
                        </button>
                      );
                    })}
                  </div>

                  <button
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={safeCurrentPage === totalPages}
                    className="btn-icon w-6 h-6 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                    title={t('view.nextPage')}
                  >
                    <ChevronRight size={13} />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Main Content */}
      {isLoading && paginatedRecords.length === 0 ? (
        <div className="glass-panel py-20 flex flex-col items-center justify-center text-[var(--text-tertiary)] gap-2">
          <RefreshCw size={22} className="animate-spin text-[var(--accent-primary)]" />
          <p className="text-xs">{t('view.loading')}</p>
        </div>
      ) : grandTotal === 0 && selectedUser === 'ALL' && !debouncedSearch ? (
        <div className="glass-panel py-20 flex flex-col items-center justify-center text-[var(--text-tertiary)]">
          <FileText size={48} className="mb-3 opacity-30" />
          <p className="text-base font-semibold text-[var(--text-primary)]">{t('view.emptyTitle')}</p>
          <p className="text-xs text-[var(--text-secondary)] mt-1">{t('view.emptyText')}</p>
        </div>
      ) : filteredCount === 0 ? (
        <div className="glass-panel py-16 flex flex-col items-center justify-center text-[var(--text-tertiary)]">
          <Search size={36} className="mb-3 opacity-30" />
          <p className="text-base font-semibold text-[var(--text-primary)]">{t('view.noMatchTitle')}</p>
          <p className="text-xs text-[var(--text-secondary)] mt-1">{t('view.noMatchText')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full">
          {paginatedRecords.map((record, recordIdx) => {
            const isExpanded = expandedIds.has(record.id);

            return (
              <motion.div 
                {...waveItem(recordIdx)}
                key={record.id} 
                className="aurora-card p-0 flex flex-col overflow-hidden transition duration-200"
              >
                {/* Pressable Card Header */}
                <div 
                  onClick={() => toggleExpand(record.id)}
                  className="p-4 border-b border-[var(--border-subtle)] bg-[rgba(var(--surface),0.5)] hover:bg-[rgba(var(--ov),0.03)] cursor-pointer transition-colors flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 select-none"
                  title={isExpanded ? t('view.clickToCollapse') : t('view.clickToExpand')}
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="p-2 rounded-[var(--radius-md)] bg-[rgba(59,111,212,0.12)] border border-[rgba(59,111,212,0.25)] text-[var(--accent-primary)] shrink-0 mt-0.5">
                      <FileText size={16} />
                    </div>
                    <div className="min-w-0">
                      <div className="font-bold text-[var(--text-primary)] text-sm flex items-center gap-2">
                        <span className="truncate max-w-xs" title={record.originalFileName}>
                          {record.originalFileName}
                        </span>
                      </div>
                      <div className="text-[11px] text-[var(--text-tertiary)] font-mono mt-0.5 truncate">
                        {t('view.exported')} <span className="font-semibold text-[var(--text-secondary)]">{record.exportedFileName}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto shrink-0">
                    {record.machine && (
                      <span className="badge-neutral font-mono text-[10px] py-0.5 px-2 flex items-center gap-1">
                        <Cpu size={11} className="text-[var(--accent-primary)]" /> {machineLabel(record.machine)}
                      </span>
                    )}
                    <span className="badge-neutral text-[10px] py-0.5 px-2 flex items-center gap-1">
                      <User size={11} className="text-[var(--orange-500)]" /> {record.user || t('shared.unknownUser')}
                    </span>
                    <span className="badge-neutral text-[10px] py-0.5 px-2 font-mono">
                      {t('view.toolCount', { count: record.changes.length })}
                    </span>
                    <div className="w-6 h-6 rounded-full bg-[rgba(var(--ov),0.06)] flex items-center justify-center text-[var(--text-secondary)] ml-1">
                      <ChevronDown 
                        size={14} 
                        className={`transition-transform duration-200 ${isExpanded ? 'rotate-180 text-[var(--accent-primary)]' : ''}`} 
                      />
                    </div>
                  </div>
                </div>

                {/* Timestamp & Actions Bar */}
                <div className="px-4 py-2 bg-[rgba(var(--ov),0.02)] border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-tertiary)]">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="flex items-center gap-1 text-[11px]">
                      <Clock size={12} /> {record.timestamp ? fmtDateTime(record.timestamp) : record.date}
                    </span>

                    {/* Compact Preview Chips when collapsed */}
                    {!isExpanded && record.changes.length > 0 && (
                      <div className="hidden sm:flex items-center gap-1 text-[10px] font-mono">
                        {record.changes.slice(0, 3).map((c, idx) => (
                          <span key={idx} className="badge-neutral text-[9px] py-0 px-1.5">
                            {c.originalT}→T{c.chosenT}
                          </span>
                        ))}
                        {record.changes.length > 3 && (
                          <span className="text-[10px] text-[var(--text-tertiary)]">+{record.changes.length - 3}</span>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2 ml-auto" onClick={e => e.stopPropagation()}>
                    <button
                      onClick={() => handleInspect(record)}
                      className="btn-secondary text-[11px] py-1 px-2.5 flex items-center gap-1"
                      title={t('view.viewCodeTitle')}
                    >
                      <Eye size={12} className="text-[var(--blue-500)]" /> {t('view.viewCode')}
                    </button>
                    <button
                      onClick={() => handleDownloadCode(record)}
                      disabled={downloadingId === record.id}
                      className="btn-secondary text-[11px] py-1 px-2.5 flex items-center gap-1 disabled:opacity-50"
                      title={t('view.downloadTitle')}
                    >
                      <Download size={12} className="text-[var(--green-500)]" /> {t('common:actions.download')}
                    </button>
                  </div>
                </div>

                {/* Tool Modifications Accordion (Expanded on demand) */}
                <AnimatePresence initial={false}>
                  {isExpanded && (
                    <motion.div
                      key="accordion-content"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                      className="overflow-hidden"
                    >
                      <div className="p-4 space-y-3 bg-[rgba(var(--surface-deep),0.4)]">
                        <div className="flex items-center justify-between">
                          <span className="section-label">{t('view.toolModifications')}</span>
                          <span className="text-[11px] text-[var(--text-tertiary)]">{t('view.toolsMapped', { count: record.changes.length })}</span>
                        </div>

                        {record.changes.map((change, i) => (
                          <div key={i} className="bg-[var(--bg-input)] border-l-2 border-l-[var(--orange-500)] p-3 rounded-r-[var(--radius-sm)] text-xs border border-[var(--border-subtle)]">
                            <div className="flex justify-between items-start mb-2">
                              <div className="font-mono font-bold text-[var(--text-primary)] flex items-center gap-2">
                                <span>{change.originalT}</span>
                                <span className="text-[var(--text-tertiary)] font-normal">→</span>
                                <span className="badge-positive font-mono text-[11px] py-0.5 px-1.5">T{change.chosenT}</span>
                              </div>
                              <div className="text-[10px] font-semibold px-2 py-0.5 rounded-[var(--radius-full)] bg-[rgba(var(--ov),0.04)] border border-[var(--border-subtle)] flex items-center gap-1.5 text-[var(--text-secondary)]">
                                {change.appChose ? (
                                  <><Bot size={11} className="text-[var(--blue-500)]"/> {t('view.autoSelection')}</>
                                ) : (
                                  <><User size={11} className="text-[var(--orange-500)]"/> {t('view.manualOverride')}</>
                                )}
                              </div>
                            </div>
                            
                            <div className="grid grid-cols-2 gap-2 mt-2 text-[11px] bg-[rgba(0,0,0,0.3)] p-2.5 rounded-[var(--radius-sm)] border border-[var(--border-subtle)]">
                              <div>
                                <div className="section-label text-[9px] mb-0.5">{t('view.originalRequest')}</div>
                                <div className="text-[var(--text-secondary)] font-mono">
                                  {change.reqDiameter ? `D${change.reqDiameter} ` : ''} 
                                  {change.reqLength ? `L${change.reqLength}` : ''}
                                </div>
                                <div className="text-[var(--text-tertiary)] truncate mt-1 text-[10px] border-t border-[var(--border-subtle)] pt-1" title={change.originalContext}>
                                  {change.originalContext || t('view.unknownContext')}
                                </div>
                              </div>
                              <div>
                                <div className="section-label text-[9px] mb-0.5">{t('view.chosenTool')}</div>
                                <div className="text-[var(--text-primary)] font-semibold flex items-center gap-1.5 flex-wrap">
                                  <span className="capitalize">{categoryLabel(change.chosenCategory)}</span>
                                  <span className="badge-neutral text-[9px] py-0 px-1 font-mono">D{change.chosenDiameter}</span>
                                  <span className="badge-neutral text-[9px] py-0 px-1 font-mono">L{change.chosenLength}</span>
                                </div>
                              </div>
                            </div>
                          </div>
                        ))}
                        
                        {record.changes.length === 0 && (
                          <div className="text-xs text-[var(--text-tertiary)] italic px-1">{t('view.noToolsModified')}</div>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            );
          })}
        </div>
      )}

      {/* Pagination Bar - Bottom */}
      {filteredCount > 0 && totalPages > 1 && (
        <div className="glass-panel px-4 py-2.5 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs mt-2">
          <div className="text-[var(--text-secondary)] font-medium">
            {t('view.page')} <span className="font-bold text-[var(--text-primary)] font-mono">{safeCurrentPage}</span> {t('view.of')} <span className="font-bold text-[var(--accent-primary)] font-mono">{totalPages}</span> {t('view.recordsTotal', { total: totalRecords })}
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={safeCurrentPage === 1}
              className="btn-secondary text-xs py-1 px-2.5 flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              title={t('view.prev10Title')}
            >
              <ChevronLeft size={13} />
              <span>{t('view.prev10')}</span>
            </button>

            <div className="flex items-center gap-1 overflow-x-auto max-w-[280px] sm:max-w-none py-0.5">
              {pageWindow(totalPages, safeCurrentPage).map(page => {
                const startNum = (page - 1) * PAGE_SIZE + 1;
                const endNum = Math.min(page * PAGE_SIZE, totalRecords);
                const isCur = page === safeCurrentPage;
                return (
                  <button
                    key={page}
                    onClick={() => setCurrentPage(page)}
                    className={`text-xs px-2.5 py-1 rounded-full font-mono transition cursor-pointer whitespace-nowrap ${
                      isCur
                        ? 'btn-primary font-bold shadow-xs'
                        : 'badge-neutral hover:bg-[rgba(var(--ov),0.08)] text-[var(--text-secondary)]'
                    }`}
                    title={t('view.showRecords', { start: startNum, end: endNum })}
                  >
                    {startNum}–{endNum}
                  </button>
                );
              })}
            </div>

            <button
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={safeCurrentPage === totalPages}
              className="btn-secondary text-xs py-1 px-2.5 flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              title={t('view.next10Title')}
            >
              <span>{t('view.next10')}</span>
              <ChevronRight size={13} />
            </button>
          </div>
        </div>
      )}

      {/* Code Inspector Modal */}
      <AnimatePresence>
        {inspectingRecord && (
          <motion.div 
            key="inspector"
            {...iosBackdrop}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 modal-backdrop"
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                setInspectingRecord(null);
                setInspectCode('');
                setIsLoadingCode(false);
              }
            }}
          >
            <motion.div
              {...iosSurface}
              className="glass-modal w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Modal Header */}
              <div className="p-4 border-b border-[var(--border-subtle)] flex items-center justify-between bg-[var(--bg-panel)]">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-[var(--radius-md)] bg-[var(--blue-500)]/15 border border-[var(--blue-500)]/30 text-[var(--blue-500)]">
                    <FileText size={18} />
                  </div>
                  <div>
                    <h3 className="font-bold text-[var(--text-primary)] text-sm">
                      {inspectingRecord.exportedFileName}
                    </h3>
                    <div className="text-[11px] text-[var(--text-tertiary)] flex items-center gap-2 mt-0.5">
                      <span>{t('view.modalOperator')} <strong className="text-[var(--text-primary)]">{inspectingRecord.user || t('shared.unknownUser')}</strong></span>
                      {inspectingRecord.machine && (
                        <>
                          <span>•</span>
                          <span>{t('view.modalMachine')} <strong className="text-[var(--blue-500)]">{machineLabel(inspectingRecord.machine)}</strong></span>
                        </>
                      )}
                      <span>•</span>
                      <span>{inspectingRecord.timestamp ? fmtDateTime(inspectingRecord.timestamp) : inspectingRecord.date}</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={handleCopyCode}
                    disabled={isLoadingCode || !inspectCode}
                    className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5 disabled:opacity-50"
                  >
                    {copied ? <Check size={13} className="text-[var(--green-500)]" /> : <Copy size={13} />}
                    <span>{copied ? t('view.copied') : t('view.copy')}</span>
                  </button>
                  <button
                    onClick={() => handleDownloadCode(inspectingRecord)}
                    className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5"
                  >
                    <Download size={13} />
                    <span>{t('common:actions.download')}</span>
                  </button>
                  <button
                    onClick={() => {
                      setInspectingRecord(null);
                      setInspectCode('');
                      setIsLoadingCode(false);
                    }}
                    className="btn-icon w-7 h-7 text-xs ml-1"
                    title={t('common:actions.close')}
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>

              {/* Code Content Area */}
              <div className="flex-1 overflow-y-auto p-4 bg-[var(--bg-input)] font-mono text-xs text-[var(--text-primary)] custom-scrollbar">
                {isLoadingCode ? (
                  <div className="flex flex-col items-center justify-center h-48 text-[var(--text-tertiary)] gap-2">
                    <div className="w-6 h-6 border-2 border-[var(--accent-primary)] border-t-transparent rounded-full animate-spin" />
                    <span>{t('view.loadingCode')}</span>
                  </div>
                ) : (
                  <pre className="whitespace-pre leading-relaxed select-all">
                    {typeof inspectCode === 'string' ? inspectCode : String(inspectCode || '')}
                  </pre>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** At most 7 page buttons around the current page, so a long history does not flood the bar. */
function pageWindow(totalPages: number, current: number): number[] {
  const size = 7;
  let start = Math.max(1, current - Math.floor(size / 2));
  const end = Math.min(totalPages, start + size - 1);
  start = Math.max(1, end - size + 1);
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}
