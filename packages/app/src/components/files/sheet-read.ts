// The cells of a spreadsheet file as plain text, capped, with the look of the cells (fills, borders, fonts, merged
// cells, column widths) when the file has one. No screen: it runs in the worker (`office.worker.ts`) or in the page
// when there is no worker. SheetJS (community build) is bundled with whichever side runs it.
import * as XLSX from 'xlsx';
import { cellStyleNumbers, readXfs, type CellCss, type Xf } from './sheet-style';
import { child, kids, parseXml } from './xml-lite';

export const SHEET_ROW_CAP = 500;
export const SHEET_COLUMN_CAP = 40;

/** How the shown cells look. Rows and columns count from the first shown cell. */
export interface SheetLook {
  styles: Array<Array<CellCss | null>>;
  merges: Array<{ r: number; c: number; rows: number; cols: number }>;
  /** Column widths and row heights in px; `null` where the file says nothing. */
  widths: Array<number | null>;
  heights: Array<number | null>;
}

export interface Sheet {
  name: string;
  rows: string[][];
  /** Rows the sheet really has (more than are shown when capped). */
  total: number;
  columns: number;
  look?: SheetLook;
}

type Files = Record<string, { content?: unknown }>;

function partText(files: Files | undefined, path: string): string | null {
  const content = files?.[path]?.content;
  if (content === undefined || content === null) return null;
  if (typeof content === 'string') return content;
  return new TextDecoder().decode(content as Uint8Array);
}

/** The sheet files of a workbook by sheet name, plus the cell styles; `null` for files that are not Excel zips (CSV, old .xls). */
function readLooks(book: XLSX.WorkBook): { xfs: Xf[]; sheetXml: (name: string) => string | null } | null {
  const files = (book as unknown as { files?: Files }).files;
  const styles = partText(files, 'xl/styles.xml');
  const workbook = partText(files, 'xl/workbook.xml');
  const rels = partText(files, 'xl/_rels/workbook.xml.rels');
  if (!styles || !workbook || !rels) return null;
  const targets = new Map(parseXml(rels).children.map((r) => [r.attrs.Id, r.attrs.Target ?? ''] as const));
  const byName = new Map<string, string>();
  for (const s of kids(child(parseXml(workbook), 'sheets'), 'sheet')) {
    const target = targets.get(s.attrs.id ?? '');
    if (s.attrs.name && target) byName.set(s.attrs.name, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }
  return { xfs: readXfs(styles, partText(files, 'xl/theme/theme1.xml')), sheetXml: (name) => partText(files, byName.get(name) ?? '') };
}

/** The sheets of a workbook as plain text cells, capped. */
export function readSheets(bytes: Uint8Array, csv: boolean): Sheet[] {
  const book = csv
    ? XLSX.read(new TextDecoder().decode(bytes), { type: 'string', sheetRows: SHEET_ROW_CAP + 1 })
    : XLSX.read(bytes, { type: 'array', sheetRows: SHEET_ROW_CAP + 1, cellFormula: false, cellStyles: true, bookFiles: true });
  const looks = csv ? null : readLooks(book);
  return book.SheetNames.map((name) => readSheet(book, name, looks));
}

function readSheet(book: XLSX.WorkBook, name: string, looks: ReturnType<typeof readLooks>): Sheet {
  const ws = book.Sheets[name];
  const ref = ws?.['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null;
  if (!ref) return { name, rows: [], total: 0, columns: 0 };
  const text = (r: number, c: number) => {
    const cell = ws[XLSX.utils.encode_cell({ r: ref.s.r + r, c: ref.s.c + c })];
    return cell ? String(XLSX.utils.format_cell(cell) ?? '') : '';
  };
  const allCols = ref.e.c - ref.s.c + 1;
  // The last row that has anything in it (`sheetRows` already stopped the read one row past the cap).
  let used = ref.e.r - ref.s.r + 1;
  while (used > 0 && Array.from({ length: allCols }, (_, c) => text(used - 1, c)).every((v) => v === '')) used--;
  const rowCount = Math.min(used, SHEET_ROW_CAP);
  const colCount = Math.min(allCols, SHEET_COLUMN_CAP);
  const rows = Array.from({ length: rowCount }, (_, r) => Array.from({ length: colCount }, (_, c) => text(r, c)));
  const sheet: Sheet = { name, rows, total: used, columns: allCols };
  if (looks) {
    const look = readLook(ws, ref, rowCount, colCount, looks, name);
    if (look) sheet.look = look;
  }
  return sheet;
}

function readLook(ws: XLSX.WorkSheet, ref: XLSX.Range, rowCount: number, colCount: number, looks: NonNullable<ReturnType<typeof readLooks>>, name: string): SheetLook | undefined {
  const xml = looks.sheetXml(name);
  const numbers = xml ? cellStyleNumbers(xml, ref.s.r + rowCount + 1) : new Map<string, number>();
  let any = false;
  const styles = Array.from({ length: rowCount }, (_, r) =>
    Array.from({ length: colCount }, (_, c): CellCss | null => {
      const xf = looks.xfs[numbers.get(`${ref.s.r + r},${ref.s.c + c}`) ?? 0];
      const cell = ws[XLSX.utils.encode_cell({ r: ref.s.r + r, c: ref.s.c + c })] as XLSX.CellObject | undefined;
      const css: CellCss = { ...(xf?.css ?? {}) };
      // Numbers sit on the right, like Excel, unless the file aligned them.
      if (cell?.t === 'n' && !xf?.aligned) css.textAlign = 'right';
      if (!Object.keys(css).length) return null;
      if (xf && Object.keys(xf.css).length) any = true;
      return css;
    }),
  );
  const merges: SheetLook['merges'] = [];
  for (const m of ws['!merges'] ?? []) {
    const r = m.s.r - ref.s.r;
    const c = m.s.c - ref.s.c;
    if (r < 0 || c < 0 || r >= rowCount || c >= colCount) continue;
    merges.push({ r, c, rows: Math.min(m.e.r - m.s.r + 1, rowCount - r), cols: Math.min(m.e.c - m.s.c + 1, colCount - c) });
  }
  const widths = Array.from({ length: colCount }, (_, c) => {
    const col = ws['!cols']?.[ref.s.c + c] as (XLSX.ColInfo & { customwidth?: unknown }) | undefined;
    // Only widths the file set on purpose (a default width says nothing about the look).
    return col?.customwidth && typeof col.wpx === 'number' && col.wpx > 0 ? Math.round(col.wpx) : null;
  });
  const heights = Array.from({ length: rowCount }, (_, r) => {
    const h = ws['!rows']?.[ref.s.r + r]?.hpx;
    return typeof h === 'number' && h > 0 ? Math.round(h) : null;
  });
  const worth = any || merges.length > 0 || widths.some((w) => w !== null);
  return worth ? { styles, merges, widths, heights } : undefined;
}
