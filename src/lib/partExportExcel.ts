import { MonthlySummaryRow } from '../types';
import { downloadBlob } from './download';

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
  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.columns = [
    { header: 'Month', key: 'month', width: 16 },
    { header: 'Total Parts', key: 'total_qty', width: 16 },
    { header: 'Total Value', key: 'total_value', width: 16 }
  ];

  params.summaryRows.forEach(row => {
    summarySheet.addRow({
      month: row.month_key,
      total_qty: row.total_qty,
      total_value: row.total_value
    });
  });

  // Sheet 2: Entries (Date, SAP Number, Quantity, Type, Unit Value, Line Value)
  const entriesSheet = workbook.addWorksheet('Entries');
  entriesSheet.columns = [
    { header: 'Date', key: 'date', width: 22 },
    { header: 'SAP Number', key: 'sap_number', width: 20 },
    { header: 'Quantity', key: 'qty', width: 14 },
    { header: 'Type', key: 'kind', width: 18 },
    { header: 'Unit Value', key: 'unit_value', width: 14 },
    { header: 'Line Value', key: 'line_value', width: 14 }
  ];

  params.entries.forEach(e => {
    const dateFormatted = e.created_at ? new Date(e.created_at).toLocaleString() : '';
    const typeLabel = e.kind === 'PRODUCED' ? 'Produced part' : 'Modification';
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
  workbook.creator = 'CNC Process Pro Admin';
  workbook.created = new Date();

  // Sheet 1: Summary (Month, Operator, Total Parts, Total Value)
  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.columns = [
    { header: 'Month', key: 'month', width: 16 },
    { header: 'Operator', key: 'username', width: 20 },
    { header: 'Total Parts', key: 'total_qty', width: 16 },
    { header: 'Total Value', key: 'total_value', width: 16 }
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
  const entriesSheet = workbook.addWorksheet('Entries');
  entriesSheet.columns = [
    { header: 'Date', key: 'date', width: 22 },
    { header: 'Operator', key: 'username', width: 18 },
    { header: 'SAP Number', key: 'sap_number', width: 20 },
    { header: 'Quantity', key: 'qty', width: 14 },
    { header: 'Type', key: 'kind', width: 18 },
    { header: 'Unit Value', key: 'unit_value', width: 14 },
    { header: 'Line Value', key: 'line_value', width: 14 },
    { header: 'Status', key: 'status', width: 16 },
    { header: 'Reviewed Date', key: 'reviewed_at', width: 22 },
    { header: 'Reviewed By', key: 'reviewed_by', width: 18 }
  ];

  params.entries.forEach(e => {
    const dateFormatted = e.created_at ? new Date(e.created_at).toLocaleString() : '';
    const reviewedDateFormatted = e.reviewed_at ? new Date(e.reviewed_at).toLocaleString() : '-';
    const typeLabel = e.kind === 'PRODUCED' ? 'Produced part' : 'Modification';
    const lineVal = Number(e.qty || 0) * Number(e.unit_value || 0);

    entriesSheet.addRow({
      date: dateFormatted,
      username: e.username,
      sap_number: e.sap_number,
      qty: e.qty,
      kind: typeLabel,
      unit_value: e.unit_value,
      line_value: lineVal,
      status: e.status,
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
