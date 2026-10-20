/**
 * One CSV cell, quoted. Text that a spreadsheet would run as a formula (starting with
 * = + - @, a tab or a carriage return) gets a leading apostrophe, so a file name such as
 * `=HYPERLINK(...)` typed by someone shows as text instead of executing in Excel.
 * Plain numbers (including negatives like -12.5) are left untouched.
 */
export function csvCell(v: unknown): string {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
