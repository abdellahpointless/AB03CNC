import { MonthlySummaryRow } from '../types';
import { downloadBlob } from './download';
import i18n from '../i18n';
import { fmtDateTime } from '../i18n/format';
import type enParts from '../i18n/locales/en/parts';

/*
 * Sheet names, column headers and text cells follow the page's language (called at export time).
 * Numeric cells stay numbers; file names stay in English.
 */

type ColumnKey = keyof (typeof enParts)['excel']['columns'];

function col(key: ColumnKey): string {
  return i18n.t(`parts:excel.columns.${key}`);
}

/** Entry kind as written in the Excel files. */
function kindLabel(kind: string): string {
  return kind === 'PRODUCED' ? i18n.t('parts:kind.producedPart') : i18n.t('parts:kind.MODIFICATION');
}

/** Review status as written in the admin Excel file (an unknown value is kept as it is). */
function statusLabel(status: string): string {
  return status === 'PENDING' || status === 'APPROVED' || status === 'REJECTED' ? i18n.t(`parts:status.${status}`) : status;
}

/**
 * Lazy Excel generator for User's Part Without Scan export.
 * Dynamically imports 'exceljs' only when called.
 */
export async function exportUserPartEntriesExcel(params: {
  username: string;
  summaryRows: MonthlySummaryRow[];
  entries: {
    created_at: string;
    sap_number: string;
    qty: number;
    kind: string;
    unit_value: number;
  }[];
}): Promise<void> {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'CNC Process Pro';
  workbook.created = new Date();

  // Sheet 1: Summary (Month, Total Parts, Total Value)
  const summarySheet = workbook.addWorksheet(i18n.t('parts:excel.sheetSummary'));
  summarySheet.columns = [
    { header: col('month'), key: 'month', width: 16 },
    { header: col('totalParts'), key: 'total_qty', width: 16 },
    { header: col('totalValue'), key: 'total_value', width: 16 }
  ];

  params.summaryRows.forEach(row => {
    summarySheet.addRow({
      month: row.month_key,
      total_qty: row.total_qty,
      total_value: row.total_value
    });
  });

  // Sheet 2: Entries (Date, SAP Number, Quantity, Type, Unit Value, Line Value)
  const entriesSheet = workbook.addWorksheet(i18n.t('parts:excel.sheetEntries'));
  entriesSheet.columns = [
    { header: col('date'), key: 'date', width: 22 },
    { header: col('sapNumber'), key: 'sap_number', width: 20 },
    { header: col('quantity'), key: 'qty', width: 14 },
    { header: col('type'), key: 'kind', width: 18 },
    { header: col('unitValue'), key: 'unit_value', width: 14 },
    { header: col('lineValue'), key: 'line_value', width: 14 }
  ];

  params.entries.forEach(e => {
    const dateFormatted = e.created_at ? fmtDateTime(e.created_at) : '';
    const typeLabel = kindLabel(e.kind);
    const lineVal = Number(e.qty || 0) * Number(e.unit_value || 0);

    entriesSheet.addRow({
      date: dateFormatted,
      sap_number: e.sap_number,
      qty: e.qty,
      kind: typeLabel,
      unit_value: e.unit_value,
      line_value: lineVal
    });
  });

  // Style header rows
  [summarySheet, entriesSheet].forEach(sheet => {
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1F2937' }
    };
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  downloadBlob(`Part_Entries_${params.username}_${dateStr}.xlsx`, blob);
}

/**
 * Lazy Excel generator for Admin Part Review export.
 * Dynamically imports 'exceljs' only when called.
 */
export async function exportAdminPartEntriesExcel(params: {
  monthFilter?: string;
  summaryRows: MonthlySummaryRow[];
  entries: {
    created_at: string;
    username: string;
    sap_number: string;
    qty: number;
    kind: string;
    unit_value: number;
    status: string;
    reviewed_at: string | null;
    reviewed_by: string | null;
  }[];
}): Promise<void> {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = i18n.t('parts:excel.creatorAdmin');
  workbook.created = new Date();

  // Sheet 1: Summary (Month, Operator, Total Parts, Total Value)
  const summarySheet = workbook.addWorksheet(i18n.t('parts:excel.sheetSummary'));
  summarySheet.columns = [
    { header: col('month'), key: 'month', width: 16 },
    { header: col('operator'), key: 'username', width: 20 },
    { header: col('totalParts'), key: 'total_qty', width: 16 },
    { header: col('totalValue'), key: 'total_value', width: 16 }
  ];

  params.summaryRows.forEach(row => {
    summarySheet.addRow({
      month: row.month_key,
      username: row.username,
      total_qty: row.total_qty,
      total_value: row.total_value
    });
  });

  // Sheet 2: Entries (Date, Operator, SAP Number, Quantity, Type, Unit Value, Line Value, Status, Reviewed Date, Reviewed By)
  const entriesSheet = workbook.addWorksheet(i18n.t('parts:excel.sheetEntries'));
  entriesSheet.columns = [
    { header: col('date'), key: 'date', width: 22 },
    { header: col('operator'), key: 'username', width: 18 },
    { header: col('sapNumber'), key: 'sap_number', width: 20 },
    { header: col('quantity'), key: 'qty', width: 14 },
    { header: col('type'), key: 'kind', width: 18 },
    { header: col('unitValue'), key: 'unit_value', width: 14 },
    { header: col('lineValue'), key: 'line_value', width: 14 },
    { header: col('status'), key: 'status', width: 16 },
    { header: col('reviewedDate'), key: 'reviewed_at', width: 22 },
    { header: col('reviewedBy'), key: 'reviewed_by', width: 18 }
  ];

  params.entries.forEach(e => {
    const dateFormatted = e.created_at ? fmtDateTime(e.created_at) : '';
    const reviewedDateFormatted = e.reviewed_at ? fmtDateTime(e.reviewed_at) : '-';
    const typeLabel = kindLabel(e.kind);
    const lineVal = Number(e.qty || 0) * Number(e.unit_value || 0);

    entriesSheet.addRow({
      date: dateFormatted,
      username: e.username,
      sap_number: e.sap_number,
      qty: e.qty,
      kind: typeLabel,
      unit_value: e.unit_value,
      line_value: lineVal,
      status: statusLabel(e.status),
      reviewed_at: reviewedDateFormatted,
      reviewed_by: e.reviewed_by || '-'
    });
  });

  // Style header rows
  [summarySheet, entriesSheet].forEach(sheet => {
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1F2937' }
    };
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const suffix = params.monthFilter ? `_${params.monthFilter}` : '_All';
  downloadBlob(`Admin_Part_Review${suffix}_${dateStr}.xlsx`, blob);
}
