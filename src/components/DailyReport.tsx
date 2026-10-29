import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Printer, RefreshCw } from 'lucide-react';
import { useSync } from '../contexts/SyncContext';
import { fetchMachinesReport, toFleet, type MachinesReport } from '../lib/fleet';
import { reportPeople, reportRows } from '../lib/preventiveReport';
import { currentRegion } from '../lib/instance';
import { dayStart, periodKey } from '../lib/shifts';
import { errorMessage } from '../lib/api';
import { fmtDateTime, fmtTime, locale } from '../i18n/format';
import { useT } from '../i18n';

/*
 * Preventive actions → Reports → Daily report (admins): one day on one printable page.
 * Nothing is stored for it: the page is rebuilt from the day's saved records (checks, problems, stops,
 * cales), which are kept forever, so any past day can be printed again. The page on screen is exactly
 * what prints: the print window gets this element and the same style.
 */

/** The printed page's look, shared by the preview and the print window (fixed black on white). */
const SHEET_CSS = `
.daily-sheet{background:#fff;color:#111;font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;width:100%;max-width:794px;min-width:620px;margin:0 auto;padding:36px 40px;border-radius:6px;box-shadow:0 18px 50px rgba(0,0,0,.35);box-sizing:border-box}
.daily-sheet *{color:inherit}
.daily-sheet .ds-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:2px solid #111;padding-bottom:12px;margin-bottom:16px}
.daily-sheet .ds-brand{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#555}
.daily-sheet h3{font-size:22px;line-height:1.2;margin:2px 0;font-weight:800}
.daily-sheet .ds-date{font-size:14px;font-weight:600}
.daily-sheet .ds-printed{font-size:12px;color:#555;text-align:right}
.daily-sheet .ds-summary{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:6px}
.daily-sheet .ds-stat{border:1px solid #ccc;border-radius:6px;padding:8px 10px}
.daily-sheet .ds-stat b{display:block;font-size:20px;line-height:1.1}
.daily-sheet .ds-stat span{font-size:12px;color:#444}
.daily-sheet .ds-stat.bad{border-color:#b91c1c}
.daily-sheet .ds-stat.bad b{color:#b91c1c}
.daily-sheet h4{font-size:12px;text-transform:uppercase;letter-spacing:.06em;margin:18px 0 6px;color:#222}
.daily-sheet table{width:100%;border-collapse:collapse;font-size:12px}
.daily-sheet th,.daily-sheet td{border:1px solid #ccc;padding:5px 7px;text-align:left;vertical-align:top}
.daily-sheet th{background:#f1f3f5;font-weight:700}
.daily-sheet tbody th{white-space:nowrap}
.daily-sheet .n{text-align:right;font-variant-numeric:tabular-nums}
.daily-sheet .ds-none{color:#555;font-style:italic;margin:4px 0}
.daily-sheet .ds-sign{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin-top:40px}
.daily-sheet .ds-sign div{border-top:1px solid #111;padding-top:4px;font-size:12px;color:#444}
@media print{@page{size:A4;margin:12mm}body{margin:0}.daily-sheet{box-shadow:none;border-radius:0;padding:0;max-width:none;min-width:0}.daily-sheet tr{break-inside:avoid}}
`;

/** The day before / after a YYYY-MM-DD day. */
const shiftDay = (day: string, by: number) => new Date(Date.parse(`${day}T12:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);

export default function DailyReport() {
  const { t } = useT('preventive');
  const { machines } = useSync();
  const fleet = useMemo(() => toFleet(machines), [machines]);
  const region = currentRegion();
  const today = periodKey('DAILY', Date.now(), region.timeZone);
  const [day, setDay] = useState(today);
  const [data, setData] = useState<MachinesReport | null>(null);
  const [error, setError] = useState('');
  const sheet = useRef<HTMLElement>(null);

  useEffect(() => {
    let alive = true;
    const [y, m, d] = day.split('-').map(Number);
    setData(null);
    fetchMachinesReport(dayStart(y, m, d, region.timeZone), dayStart(y, m, d + 1, region.timeZone)).then(
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
  }, [day, region.timeZone]);

  const nameOf = (id: string) => fleet.find((m) => m.id === id)?.name ?? id;
  const rows = useMemo(() => (data ? reportRows(data, nameOf, (h, count) => t('reports.caleDetails', { h, count })) : []), [data, fleet, t]);
  const people = useMemo(() => (data ? reportPeople(data, rows) : []), [data, rows]);
  const [y, m, d] = day.split('-').map(Number);
  const longDate = new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

  const print = () => {
    if (!sheet.current) return;
    const w = window.open('', '_blank');
    if (!w) return setError(t('stock.popupBlocked'));
    w.document.write(
      `<!doctype html><html lang="${document.documentElement.lang}"><head><meta charset="utf-8"><title>${t('daily.file')}-${day}</title><style>${SHEET_CSS}</style></head><body>${sheet.current.outerHTML}</body></html>`,
    );
    w.document.close();
    w.focus();
    w.print();
  };

  const count = (k: string) => rows.filter((r) => r.kind === k).length;
  const per = (id: string) => data?.machines.find((r) => r.machine_id === id);
  const stats: [string, number, boolean][] = data
    ? [
        [t('daily.checks'), data.machines.reduce((n, r) => n + r.checks, 0), false],
        [t('daily.calesBoxes'), data.machines.reduce((n, r) => n + r.cales, 0), false],
        [t('daily.problems'), count('PROBLEM'), count('PROBLEM') > 0],
        [t('daily.stops'), count('MACHINE_DOWN'), count('MACHINE_DOWN') > 0],
        [t('daily.notDone'), count('MISSED'), count('MISSED') > 0],
        [t('daily.calesIssues'), count('CALES_MISSING') + count('CALES_DAMAGED'), count('CALES_MISSING') + count('CALES_DAMAGED') > 0],
        [t('daily.taken'), data.taken.reduce((n, r) => n + r.count, 0), false],
        [t('daily.people'), people.length, false],
      ]
    : [];

  return (
    <div className="space-y-4">
      <div className="glass-panel p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-[var(--text-primary)]">{t('daily.heading')}</h2>
          <p className="text-xs text-[var(--text-secondary)] mt-0.5">{t('daily.help')}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap md:flex-nowrap md:shrink-0">
          <button type="button" className="btn-icon" aria-label={t('daily.prevDay')} onClick={() => setDay(shiftDay(day, -1))}>
            <ChevronLeft size={16} />
          </button>
          <label className="sr-only" htmlFor="daily-day">
            {t('daily.day')}
          </label>
          <input id="daily-day" type="date" className="aurora-input text-sm" value={day} max={today} onChange={(e) => e.target.value && setDay(e.target.value)} />
          <button type="button" className="btn-icon" aria-label={t('daily.nextDay')} disabled={day >= today} onClick={() => setDay(shiftDay(day, 1))}>
            <ChevronRight size={16} />
          </button>
          <button type="button" className="btn-primary text-sm py-2 px-4" disabled={!data} onClick={print}>
            <Printer size={15} />
            <span>{t('daily.print')}</span>
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" className="badge-danger justify-center py-2 text-xs">
          {error}
        </div>
      )}

      {!data ? (
        !error && (
          <div className="aurora-card aurora-card-static p-8 text-center text-xs text-[var(--text-tertiary)] flex items-center justify-center gap-2">
            <RefreshCw size={14} className="animate-spin" /> {t('reports.loading')}
          </div>
        )
      ) : (
        <div className="daily-paper" tabIndex={0} role="region" aria-label={t('daily.preview')}>
          <style>{SHEET_CSS}</style>
          <article ref={sheet} className="daily-sheet">
            <header className="ds-head">
              <div>
                <div className="ds-brand">CNC Process Pro · {region.name}</div>
                <h3>{t('daily.title')}</h3>
                <div className="ds-date">{longDate}</div>
              </div>
              <div className="ds-printed">{t('daily.printed', { time: fmtDateTime(Date.now()) })}</div>
            </header>

            <div className="ds-summary">
              {stats.map(([label, n, bad]) => (
                <div key={label} className={`ds-stat ${bad ? 'bad' : ''}`}>
                  <b>{n}</b>
                  <span>{label}</span>
                </div>
              ))}
            </div>

            <h4>{t('daily.machinesTitle')}</h4>
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('reports.excel.machine')}</th>
                  <th scope="col" className="n">{t('daily.checks')}</th>
                  <th scope="col" className="n">{t('daily.calesBoxes')}</th>
                  <th scope="col" className="n">{t('daily.problems')}</th>
                  <th scope="col" className="n">{t('daily.stops')}</th>
                  <th scope="col" className="n">{t('daily.calesIssues')}</th>
                  <th scope="col" className="n">{t('daily.taken')}</th>
                </tr>
              </thead>
              <tbody>
                {fleet.map((f) => (
                  <tr key={f.id}>
                    <th scope="row">{f.name}</th>
                    <td className="n">{per(f.id)?.checks ?? 0}</td>
                    <td className="n">{per(f.id)?.cales ?? 0}</td>
                    <td className="n">{rows.filter((r) => r.machine === f.name && r.kind === 'PROBLEM').length}</td>
                    <td className="n">{rows.filter((r) => r.machine === f.name && r.kind === 'MACHINE_DOWN').length}</td>
                    <td className="n">{rows.filter((r) => r.machine === f.name && (r.kind === 'CALES_MISSING' || r.kind === 'CALES_DAMAGED')).length}</td>
                    <td className="n">{data.taken.filter((r) => r.machine_id === f.id).reduce((n, r) => n + r.count, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h4>{t('reports.listTitle')}</h4>
            {rows.length === 0 ? (
              <p className="ds-none">{t('daily.nothing')}</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('daily.time')}</th>
                    <th scope="col">{t('reports.excel.machine')}</th>
                    <th scope="col">{t('reports.excel.what')}</th>
                    <th scope="col">{t('reports.excel.details')}</th>
                    <th scope="col">{t('reports.excel.by')}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...rows].reverse().map((r, i) => (
                    <tr key={i}>
                      <td>{fmtTime(r.at)}</td>
                      <td>{r.machine}</td>
                      <td>{t(`reports.kind.${r.kind}`)}</td>
                      <td>
                        {r.details}
                        {r.notDoneBy && <div>{t('reports.notDoneBy', { users: r.notDoneBy })}</div>}
                      </td>
                      <td>{r.by}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {data.truncated && <p className="ds-none">{t('reports.truncated', { count: 2000 })}</p>}

            <h4>{t('daily.takenTitle')}</h4>
            {data.taken.length === 0 ? (
              <p className="ds-none">{t('daily.noTaken')}</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('daily.time')}</th>
                    <th scope="col">{t('reports.excel.machine')}</th>
                    <th scope="col">{t('stock.size')}</th>
                    <th scope="col" className="n">{t('stock.excel.count')}</th>
                    <th scope="col">{t('stock.askedByCol')}</th>
                    <th scope="col">{t('stock.approvedByCol')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.taken.map((r, i) => (
                    <tr key={i}>
                      <td>{fmtTime(r.at)}</td>
                      <td>{nameOf(r.machine_id)}</td>
                      <td>{r.height} mm</td>
                      <td className="n">{r.count}</td>
                      <td>{r.requested_by}</td>
                      <td>{r.decided_by}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h4>{t('reports.peopleTitle')}</h4>
            {people.length === 0 ? (
              <p className="ds-none">{t('daily.noPeople')}</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('reports.excel.person')}</th>
                    <th scope="col" className="n">{t('reports.excel.done')}</th>
                    <th scope="col" className="n">{t('reports.excel.problems')}</th>
                    <th scope="col" className="n">{t('reports.excel.notDone')}</th>
                  </tr>
                </thead>
                <tbody>
                  {people.map((p) => (
                    <tr key={p.username}>
                      <td>{p.username}</td>
                      <td className="n">{p.done}</td>
                      <td className="n">{p.problems}</td>
                      <td className="n">{p.notDone}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className="ds-sign">
              <div>{t('daily.checkedBy')}</div>
              <div>{t('daily.signature')}</div>
              <div>{t('daily.signDate')}</div>
            </div>
          </article>
        </div>
      )}
    </div>
  );
}
