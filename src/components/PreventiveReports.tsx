import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ClipboardX, FileSpreadsheet, OctagonX, PackageX, RefreshCw, ShieldAlert, Trophy } from 'lucide-react';
import { useSync } from '../contexts/SyncContext';
import { fetchMachinesReport, toFleet, type MachinesReport } from '../lib/fleet';
import { payPeriod, periodMs } from '../lib/partsApi';
import { errorMessage } from '../lib/api';
import { downloadBlob } from '../lib/download';
import { fmtDateTime } from '../i18n/format';
import { useT } from '../i18n';
import PeriodPicker from './PeriodPicker';

/*
 * Preventive actions → Reports (admins): only what did not go well in the period (problems,
 * stopped machines, tasks the next shift reported as not done, missing or damaged cales), and who
 * confirms their checks the most. Everything can be downloaded as an Excel file.
 */

type Kind = 'PROBLEM' | 'MACHINE_DOWN' | 'MISSED' | 'CALES_MISSING' | 'CALES_DAMAGED';
interface Row {
  at: number;
  machine: string;
  kind: Kind;
  details: string;
  notDoneBy: string;
  by: string;
}
interface Person {
  username: string;
  done: number;
  problems: number;
  notDone: number;
}

const KIND_ICON: Record<Kind, typeof AlertTriangle> = {
  PROBLEM: AlertTriangle,
  MACHINE_DOWN: OctagonX,
  MISSED: ClipboardX,
  CALES_MISSING: PackageX,
  CALES_DAMAGED: ShieldAlert,
};
const KIND_TONE: Record<Kind, string> = {
  PROBLEM: 'badge-warning',
  MACHINE_DOWN: 'badge-danger',
  MISSED: 'badge-danger',
  CALES_MISSING: 'badge-warning',
  CALES_DAMAGED: 'badge-warning',
};

export default function PreventiveReports() {
  const { t } = useT('preventive');
  const { machines, versions } = useSync();
  const nameOf = useMemo(() => {
    const fleet = toFleet(machines);
    return (id: string) => fleet.find((m) => m.id === id)?.name ?? id;
  }, [machines]);
  const [period, setPeriod] = useState(() => payPeriod());
  const [data, setData] = useState<MachinesReport | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const { from, to } = periodMs(period);
    fetchMachinesReport(from, to).then(
      (r) => {
        if (!alive) return;
        setData(r);
        setError('');
      },
      (e) => alive && setError(errorMessage(e)),
    );
    return () => {
      alive = false;
    };
  }, [period, versions.machines]);

  const rows = useMemo<Row[]>(() => {
    if (!data) return [];
    const out: Row[] = data.events.map((e) => ({
      at: e.at,
      machine: nameOf(e.machine_id),
      kind: e.action,
      details: e.action === 'PROBLEM' ? [e.check_title, e.note].filter(Boolean).join(' · ') : e.check_title ?? e.note ?? '',
      notDoneBy: e.action === 'MISSED' ? e.note ?? '' : '',
      by: e.username,
    }));
    for (const c of data.cales)
      out.push({
        at: c.at,
        machine: nameOf(c.machine_id),
        kind: c.kind === 'MISSING' ? 'CALES_MISSING' : 'CALES_DAMAGED',
        details: t('reports.caleDetails', { h: c.height, count: c.count }),
        notDoneBy: '',
        by: c.username,
      });
    return out.sort((a, b) => b.at - a.at);
  }, [data, nameOf, t]);

  const people = useMemo<Person[]>(() => {
    if (!data) return [];
    const map = new Map<string, Person>();
    const get = (u: string) => {
      const k = u.toLowerCase();
      if (!map.has(k)) map.set(k, { username: u, done: 0, problems: 0, notDone: 0 });
      return map.get(k)!;
    };
    for (const p of data.people) Object.assign(get(p.username), { done: p.done, problems: p.problems });
    for (const r of rows)
      if (r.kind === 'MISSED')
        for (const u of r.notDoneBy.split(',').map((s) => s.trim()).filter(Boolean)) if (!data.hidden.includes(u.toLowerCase())) get(u).notDone++;
    return [...map.values()].sort((a, b) => b.done - a.done || a.notDone - b.notDone);
  }, [data, rows]);

  const count = (k: Kind) => rows.filter((r) => r.kind === k).length;
  const best = Math.max(1, ...people.map((p) => p.done));
  const kindLabel = (k: Kind) => t(`reports.kind.${k}`);

  const exportExcel = async () => {
    setBusy(true);
    try {
      const ExcelJS = await import('exceljs');
      const book = new ExcelJS.Workbook();
      book.creator = 'CNC Process Pro';
      const list = book.addWorksheet(t('reports.excel.sheetEvents'));
      list.columns = [
        { header: t('reports.excel.date'), key: 'date', width: 20 },
        { header: t('reports.excel.machine'), key: 'machine', width: 16 },
        { header: t('reports.excel.what'), key: 'what', width: 26 },
        { header: t('reports.excel.details'), key: 'details', width: 44 },
        { header: t('reports.excel.notDoneBy'), key: 'notDoneBy', width: 20 },
        { header: t('reports.excel.by'), key: 'by', width: 16 },
      ];
      for (const r of rows) list.addRow({ date: fmtDateTime(r.at), machine: r.machine, what: kindLabel(r.kind), details: r.details, notDoneBy: r.notDoneBy, by: r.by });
      const ppl = book.addWorksheet(t('reports.excel.sheetPeople'));
      ppl.columns = [
        { header: t('reports.excel.person'), key: 'username', width: 18 },
        { header: t('reports.excel.done'), key: 'done', width: 18 },
        { header: t('reports.excel.problems'), key: 'problems', width: 18 },
        { header: t('reports.excel.notDone'), key: 'notDone', width: 22 },
      ];
      for (const p of people) ppl.addRow(p);
      for (const sheet of [list, ppl]) {
        const head = sheet.getRow(1);
        head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
      }
      const buffer = await book.xlsx.writeBuffer();
      downloadBlob(`Preventive_report_${period.from}_${period.to}.xlsx`, new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col space-y-6 max-w-6xl mx-auto w-full pb-16">
      <div className="glass-panel p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-[var(--radius-md)] bg-[var(--rose-500)]/12 border border-[var(--rose-500)]/30 flex items-center justify-center text-[var(--rose-500)] shrink-0">
            <ClipboardX size={22} />
          </div>
          <div>
            <h2 className="text-xl font-bold tracking-tight text-[var(--text-primary)]">{t('reports.title')}</h2>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">{t('reports.subtitle')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2.5 flex-wrap">
          <PeriodPicker value={period} onChange={setPeriod} />
          <button type="button" className="btn-secondary text-xs py-2 px-3" disabled={busy || !data} onClick={exportExcel}>
            {busy ? <RefreshCw size={14} className="animate-spin" /> : <FileSpreadsheet size={15} className="text-[var(--green-500)]" />}
            <span>{t('reports.export')}</span>
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" className="badge-danger justify-center py-2 text-xs">
          {error}
        </div>
      )}

      {!data && !error && (
        <div className="aurora-card aurora-card-static p-8 text-center text-xs text-[var(--text-tertiary)] flex items-center justify-center gap-2">
          <RefreshCw size={14} className="animate-spin" /> {t('reports.loading')}
        </div>
      )}

      {data && (
        <>
          <div className="flex flex-wrap gap-2">
            {(['MACHINE_DOWN', 'PROBLEM', 'MISSED', 'CALES_MISSING', 'CALES_DAMAGED'] as Kind[]).map((k) => {
              const Icon = KIND_ICON[k];
              const n = count(k);
              return (
                <span key={k} className={n ? KIND_TONE[k] : 'badge-neutral'}>
                  <Icon size={13} /> {kindLabel(k)}: {n}
                </span>
              );
            })}
          </div>

          <section className="aurora-card aurora-card-static p-6 space-y-4">
            <div className="flex items-center gap-2.5">
              <Trophy size={16} className="text-[var(--green-500)]" />
              <div>
                <h3 className="section-label text-[var(--text-primary)]">{t('reports.peopleTitle')}</h3>
                <p className="text-xs text-[var(--text-tertiary)] mt-0.5">{t('reports.peopleHelp')}</p>
              </div>
            </div>
            {people.length === 0 ? (
              <p className="text-xs text-[var(--text-tertiary)]">{t('reports.noPeople')}</p>
            ) : (
              <ul className="space-y-3">
                {people.map((p) => (
                  <li key={p.username} className="grid grid-cols-[minmax(6rem,10rem)_1fr] items-center gap-3 text-xs">
                    <span className="font-semibold text-[var(--text-primary)] truncate">{p.username}</span>
                    <div className="space-y-1 min-w-0">
                      <div className="h-2.5 rounded-full bg-[rgba(var(--ov),0.06)] overflow-hidden" aria-hidden="true">
                        <div className="h-full rounded-full bg-[var(--green-500)]" style={{ width: `${(p.done / best) * 100}%` }} />
                      </div>
                      <div className="flex flex-wrap gap-x-3 text-[var(--text-secondary)]">
                        <span>{t('reports.done', { count: p.done })}</span>
                        {p.problems > 0 && <span className="text-[var(--orange-text)]">{t('reports.problemsFound', { count: p.problems })}</span>}
                        {p.notDone > 0 && <span className="text-[var(--rose-500)] font-semibold">{t('reports.reportedNotDone', { count: p.notDone })}</span>}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="aurora-card aurora-card-static p-0 overflow-hidden">
            <div className="p-5 border-b border-[var(--border-subtle)]">
              <h3 className="section-label text-[var(--text-primary)]">{t('reports.listTitle')}</h3>
            </div>
            {rows.length === 0 ? (
              <p className="p-8 text-center text-sm text-[var(--text-secondary)]">{t('reports.nothing')}</p>
            ) : (
              <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={t('reports.listTitle')}>
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-[var(--border-subtle)] bg-[rgba(var(--ov),0.02)]">
                      {(['date', 'machine', 'what', 'details', 'by'] as const).map((c) => (
                        <th key={c} scope="col" className="px-4 py-2.5 section-label whitespace-nowrap">
                          {t(`reports.excel.${c}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => {
                      const Icon = KIND_ICON[r.kind];
                      return (
                        <tr key={i} className="border-b border-[var(--border-subtle)] align-top">
                          <td className="px-4 py-2.5 whitespace-nowrap text-[var(--text-secondary)] tabular-nums">{fmtDateTime(r.at)}</td>
                          <td className="px-4 py-2.5 whitespace-nowrap font-semibold text-[var(--text-primary)]">{r.machine}</td>
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            <span className={KIND_TONE[r.kind]}>
                              <Icon size={12} /> {kindLabel(r.kind)}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-[var(--text-primary)] min-w-[14rem]">
                            {r.details}
                            {r.notDoneBy && <span className="block text-[var(--rose-500)] font-semibold">{t('reports.notDoneBy', { users: r.notDoneBy })}</span>}
                          </td>
                          <td className="px-4 py-2.5 whitespace-nowrap text-[var(--text-secondary)]">{r.by}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
