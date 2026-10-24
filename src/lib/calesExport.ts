import { CALE_HEIGHTS, type CaleHeight, type orderRows } from './cales';
import type { CaleEvent, FleetMachine } from './fleet';
import { currentRegion } from './instance';
import { periodKey } from './shifts';
import { downloadBlob } from './download';
import i18n from '../i18n';
import { fmtDateTime } from '../i18n/format';

/*
 * "Export to order": sheet 1 is what to order now (every pair still missing or damaged, less the spare
 * stock, in single cales); sheet 2 is every cales report of the chosen period. Texts follow the page's
 * language; the file name stays in English. exceljs is only downloaded when this runs.
 */

const SHIFT_HOURS = ['08-16', '16-24', '00-08'];

export async function exportCalesOrder(p: {
  rows: ReturnType<typeof orderRows>;
  events: CaleEvent[];
  fleet: FleetMachine[];
  from: number;
  /** End of the period (excluded). */
  to: number;
}): Promise<void> {
  const ExcelJS = await import('exceljs');
  const book = new ExcelJS.Workbook();
  book.creator = 'CNC Process Pro';
  book.created = new Date();
  const nameOf = (id: string) => p.fleet.find((m) => m.id === id)?.name ?? id;
  const place = (m: string, h: number) => p.fleet.findIndex((f) => f.id === m) * 100 + CALE_HEIGHTS.indexOf(h as CaleHeight);

  const order = book.addWorksheet(i18n.t('preventive:stock.excel.sheetOrder'));
  order.columns = [
    { header: i18n.t('preventive:stock.excel.machine'), key: 'machine', width: 18 },
    { header: i18n.t('preventive:stock.excel.height'), key: 'height', width: 12 },
    { header: i18n.t('preventive:stock.excel.missing'), key: 'missing', width: 16 },
    { header: i18n.t('preventive:stock.excel.damaged'), key: 'damaged', width: 16 },
    { header: i18n.t('preventive:stock.excel.stock'), key: 'stock', width: 16 },
    { header: i18n.t('preventive:stock.excel.toOrder'), key: 'toOrder', width: 16 },
  ];
  const rows = [...p.rows].sort((a, b) => place(a.machine_id, a.height) - place(b.machine_id, b.height));
  for (const r of rows) order.addRow({ machine: nameOf(r.machine_id), height: r.height, missing: r.missing, damaged: r.damaged, stock: r.stock, toOrder: r.toOrder });
  const sum = (k: 'missing' | 'damaged' | 'toOrder') => rows.reduce((n, r) => n + r[k], 0);
  order.addRow({ machine: i18n.t('preventive:stock.excel.total'), missing: sum('missing'), damaged: sum('damaged'), toOrder: sum('toOrder') }).font = { bold: true };

  const log = book.addWorksheet(i18n.t('preventive:stock.excel.sheetLog'));
  log.columns = [
    { header: i18n.t('preventive:stock.excel.date'), key: 'date', width: 20 },
    { header: i18n.t('preventive:stock.excel.shift'), key: 'shift', width: 12 },
    { header: i18n.t('preventive:stock.excel.machine'), key: 'machine', width: 18 },
    { header: i18n.t('preventive:stock.excel.height'), key: 'height', width: 12 },
    { header: i18n.t('preventive:stock.excel.what'), key: 'what', width: 14 },
    { header: i18n.t('preventive:stock.excel.count'), key: 'count', width: 10 },
    { header: i18n.t('preventive:stock.excel.user'), key: 'user', width: 16 },
  ];
  for (const e of p.events) {
    const n = Number(e.shift_key.slice(-1));
    log.addRow({
      date: fmtDateTime(e.at),
      shift: `${n} (${SHIFT_HOURS[n - 1] ?? ''})`,
      machine: nameOf(e.machine_id),
      height: e.height,
      what: i18n.t(`preventive:stock.kind.${e.kind}`),
      count: e.count,
      user: e.username,
    });
  }

  for (const sheet of [order, log]) {
    const head = sheet.getRow(1);
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
  }

  const buffer = await book.xlsx.writeBuffer();
  const tz = currentRegion().timeZone;
  downloadBlob(
    `Cales_order_${periodKey('DAILY', p.from, tz)}_${periodKey('DAILY', p.to - 1, tz)}.xlsx`,
    new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
  );
}
