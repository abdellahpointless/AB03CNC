import { CALE_HEIGHTS, type CaleHeight, type CaleRow, type StockRow, type orderRows } from './cales';
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
  /** Pairs not in good shape now, and the spare cales: the two tables of the admin page. */
  state: CaleRow[];
  stock: StockRow[];
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

  // The two tables of the admin page, as they are now: cales in each machine's box, and spares.
  const grid = (name: string, value: (m: string, h: number) => number) => {
    const sheet = book.addWorksheet(name);
    sheet.columns = [{ header: i18n.t('preventive:stock.excel.machine'), key: 'machine', width: 18 }, ...CALE_HEIGHTS.map((h) => ({ header: `${h}`, key: `h${h}`, width: 8 }))];
    for (const m of p.fleet) sheet.addRow({ machine: m.name, ...Object.fromEntries(CALE_HEIGHTS.map((h) => [`h${h}`, value(m.id, h)])) });
    return sheet;
  };
  const onMachine = grid(i18n.t('preventive:stock.onMachine'), (m, h) => {
    const st = p.state.find((r) => r.machine_id === m && r.height === h);
    return st?.status === 'MISSING' ? 2 - st.count : 2;
  });
  const spare = grid(i18n.t('preventive:stock.securityStock'), (m, h) => p.stock.find((r) => r.machine_id === m && r.height === h)?.qty ?? 0);

  for (const sheet of [order, log, onMachine, spare]) {
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
