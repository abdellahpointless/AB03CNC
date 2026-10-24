import React, { useEffect, useState } from 'react';
import { machineName } from '../lib/machines';
import { HistoryRecord } from '../types';
import { Search, Download, FileText, UserCircle, RefreshCw } from 'lucide-react';
import { applyG53BeforeG52 } from '../lib/gcodeProcessor';
import { fetchHistoryPage, fetchRecordCode } from '../lib/historyApi';
import { downloadText } from '../lib/download';
import { useSync } from '../contexts/SyncContext';
import { useT } from '../i18n';
import { fmtDateTime } from '../i18n/format';

export default function RecentCodes() {
  const { t } = useT('history');
  const { versions, machines } = useSync();
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [filteredHistory, setFilteredHistory] = useState<HistoryRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchTerm.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  // The 100 most recent programs (matching the search), refreshed when anyone exports a new one
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    fetchHistoryPage({ limit: 100, offset: 0, q: debouncedSearch || undefined })
      .then(res => {
        if (cancelled) return;
        setFilteredHistory(res.records);
        setLoadError(null);
      })
      .catch(err => {
        if (!cancelled) setLoadError(err?.message || t('recent.errors.loadFailed'));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedSearch, versions.history]);

  const handleExportAgain = async (record: HistoryRecord) => {
    setDownloadingId(record.id);
    try {
      const savedCode = await fetchRecordCode(record.id);
      const { lines: safeLines } = applyG53BeforeG52(savedCode.split('\n'));
      downloadText(record.exportedFileName, safeLines.join('\n'), 'application/octet-stream');
    } catch (e: any) {
      alert(e?.message || t('shared.codeUnavailable'));
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <div className="max-w-4xl mx-auto w-full space-y-4 pb-12">
      {/* Header Glass Panel */}
      <div className="glass-panel p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-[var(--radius-md)] bg-[var(--blue-500)]/15 border border-[var(--blue-500)]/30 text-[var(--blue-500)]">
              <FileText size={20} />
            </div>
            <h2 className="text-xl font-bold text-[var(--text-primary)]">
              {t('recent.title')}
            </h2>
          </div>
          <p className="text-xs text-[var(--text-secondary)] mt-1.5 pl-1">
            {t('recent.subtitle')}
          </p>
        </div>
      </div>

      {/* Main Container Card */}
      <div className="aurora-card p-5 space-y-4">
        <div className="relative">
          <label className="absolute inset-y-0 left-3.5 flex items-center text-[var(--text-tertiary)] pointer-events-none">
            <Search size={16} />
          </label>
          <input
            type="text"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            placeholder={t('recent.searchPlaceholder')}
            className="aurora-input w-full pl-10 text-xs py-2.5"
          />
        </div>

        {loadError && (
          <div className="badge-danger w-full py-2 px-3 text-xs">{loadError}</div>
        )}

        {isLoading && filteredHistory.length === 0 ? (
           <div className="text-center py-16 text-[var(--text-tertiary)] text-xs flex flex-col items-center gap-2">
              <RefreshCw size={18} className="animate-spin text-[var(--accent-primary)]" />
              <span>{t('recent.loading')}</span>
           </div>
        ) : filteredHistory.length === 0 ? (
           <div className="text-center py-16 text-[var(--text-tertiary)] bg-[var(--bg-input)] rounded-[var(--radius-md)] border border-dashed border-[var(--border-subtle)]">
              <FileText size={36} className="mx-auto mb-2 opacity-30" />
              <p className="text-sm font-semibold text-[var(--text-secondary)]">{t('recent.emptyTitle')}</p>
              <p className="text-xs text-[var(--text-tertiary)] mt-0.5">{t('recent.emptyText')}</p>
           </div>
        ) : (
           <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1 custom-scrollbar">
             {filteredHistory.map((record, recordIdx) => (
               <div 
                 key={record.id} 
                 style={{ '--i': recordIdx } as React.CSSProperties}
                 className="wave-in p-4 border border-[var(--border-subtle)] rounded-[var(--radius-md)] bg-[var(--bg-card)] hover:bg-[var(--bg-card-hover)] transition flex items-center justify-between gap-4 group"
               >
                 <div className="flex flex-col space-y-1.5 flex-1 min-w-0">
                   <div className="flex items-center gap-2">
                     <span className="font-mono text-xs font-bold text-[var(--text-primary)] truncate">
                       {record.exportedFileName}
                     </span>
                     {record.machine && (
                       <span className="badge-neutral text-[10px] py-0 px-1.5 font-mono">
                         {machineName(machines, record.machine)}
                       </span>
                     )}
                   </div>
                   <div className="text-[11px] text-[var(--text-tertiary)] flex items-center gap-2 flex-wrap">
                     {record.originalFileName !== record.exportedFileName && (
                       <>
                         <span>{t('recent.source')} <span className="text-[var(--text-secondary)]">{record.originalFileName}</span></span>
                         <span>•</span>
                       </>
                     )}
                     <span>{record.timestamp ? fmtDateTime(record.timestamp) : record.date}</span>
                     {record.user && (
                       <>
                         <span>•</span>
                         <span className="flex items-center gap-1 text-[var(--text-secondary)]">
                           <UserCircle size={11} className="text-[var(--orange-500)]" /> {record.user}
                         </span>
                       </>
                     )}
                   </div>
                   {record.changes && record.changes.length > 0 && (
                     <div className="flex flex-wrap gap-1 mt-1">
                        {record.changes.slice(0, 6).map((c, i) => (
                           <span key={i} className="badge-positive font-mono text-[9px] py-0 px-1.5">
                             {c.originalT} → T{c.chosenT}
                           </span>
                        ))}
                        {record.changes.length > 6 && (
                           <span className="badge-neutral text-[9px] py-0 px-1.5">
                             {t('recent.more', { count: record.changes.length - 6 })}
                           </span>
                        )}
                     </div>
                   )}
                 </div>
                 
                 <button
                    onClick={() => handleExportAgain(record)}
                    disabled={downloadingId === record.id}
                    className="btn-primary text-xs py-2 px-3 flex items-center gap-1.5 shrink-0"
                    title={t('recent.exportAgainTitle')}
                 >
                   <Download size={14} />
                   <span className="hidden sm:inline">{t('common:actions.export')}</span>
                 </button>
               </div>
             ))}
           </div>
        )}
      </div>
    </div>
  );
}
