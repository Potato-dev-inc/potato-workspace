// The cells of a spreadsheet file as plain text, capped. No screen: it runs in the worker (`office.worker.ts`) or in
// the page when there is no worker. SheetJS (community build) is bundled with whichever side runs it.
import * as XLSX from 'xlsx';

export const SHEET_ROW_CAP = 500;
export const SHEET_COLUMN_CAP = 40;

export interface Sheet {
  name: string;
  rows: string[][];
  /** Rows the sheet really has (more than are shown when capped). */
  total: number;
  columns: number;
}

/** The sheets of a workbook as plain text cells, capped. */
export function readSheets(bytes: Uint8Array, csv: boolean): Sheet[] {
  const book = csv
    ? XLSX.read(new TextDecoder().decode(bytes), { type: 'string', sheetRows: SHEET_ROW_CAP + 1 })
    : XLSX.read(bytes, { type: 'array', sheetRows: SHEET_ROW_CAP + 1, cellFormula: false });
  return book.SheetNames.map((name) => {
    const all = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[name], { header: 1, raw: false, defval: '', blankrows: false });
    const columns = all.reduce((n, r) => Math.max(n, r.length), 0);
    const rows = all.slice(0, SHEET_ROW_CAP).map((r) => r.slice(0, SHEET_COLUMN_CAP).map((c) => String(c ?? '')));
    // `sheetRows` stops reading one row past the cap, so "more than the cap" is known without reading everything.
    return { name, rows, total: all.length, columns };
  });
}
