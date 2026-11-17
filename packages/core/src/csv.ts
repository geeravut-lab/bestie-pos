/**
 * CSV export helper. Two safety rules:
 *  - quote every field that contains a comma, quote or newline;
 *  - neutralise spreadsheet formula injection: a cell starting with = + - @ (or a tab / CR) is prefixed with an
 *    apostrophe, so an audit "detail" like `=HYPERLINK(...)` can never run when the owner opens the file in Excel.
 * A UTF-8 BOM is added so Excel shows Thai correctly.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (typeof value === 'string' && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(
  header: readonly string[],
  rows: readonly (readonly unknown[])[],
  opts: { bom?: boolean } = {},
): string {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(','));
  return (opts.bom === false ? '' : '﻿') + lines.join('\r\n') + '\r\n';
}
