/**
 * Rows to CSV for spreadsheets. Cells come partly from students (typed names),
 * so anything Excel would run as a formula (=, +, -, @) is prefixed with an
 * apostrophe and shown as plain text.
 */
export function toCsv(rows: string[][]): string {
  const cell = (raw: string) => {
    let value = String(raw ?? '');
    if (/^[=+\-@\t\r]/.test(value)) value = `'${value}`;
    return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  };
  // A BOM so Excel reads names with accents as UTF-8.
  return `﻿${rows.map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
}
