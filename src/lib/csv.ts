/**
 * One CSV cell, quoted. Text that a spreadsheet would run as a formula (starting with
 * = + - @, a tab or a carriage return) gets a leading apostrophe, so a file name such as
 * `=HYPERLINK(...)` typed by someone shows as text instead of executing in Excel.
 * Plain numbers (including negatives like -12.5) and "-" placeholders are left untouched.
 */
export function csvCell(v: unknown): string {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?$/.test(s) && !/^-+$/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * CSV dialect of a language. Excel in Türkiye (like most of Europe) expects ";" between columns
 * and a decimal comma; with "," it shows everything in one column and may read 4.2 as a date.
 */
export function csvDialect(language: string): { sep: string; num: (v: unknown) => unknown } {
  if (language === 'tr') {
    return { sep: ';', num: (v) => (typeof v === 'number' ? String(v).replace('.', ',') : v) };
  }
  return { sep: ',', num: (v) => v };
}
