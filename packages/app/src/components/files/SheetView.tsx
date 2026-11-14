// A spreadsheet (.xlsx, .xls, .csv) as a table: the first sheet, a picker for the others, and a cap on rows and
// columns so a huge file cannot freeze the app. SheetJS (community build) is its own chunk, loaded on first open.
import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { useT } from '../../i18n';

export const SHEET_ROW_CAP = 500;
export const SHEET_COLUMN_CAP = 40;

interface Sheet {
  name: string;
  rows: string[][];
  /** Rows the sheet really has (more than are shown when capped). */
  total: number;
  columns: number;
}

/** The sheets of a workbook as plain text cells, capped. Exported for tests. */
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

export function SheetView({ bytes, csv, onCapped }: { bytes: Uint8Array; csv: boolean; onCapped?: (capped: boolean) => void }) {
  const t = useT();
  const [picked, setPicked] = useState(0);
  const parsed = useMemo(() => {
    try {
      return { sheets: readSheets(bytes, csv), failed: false };
    } catch {
      return { sheets: [] as Sheet[], failed: true };
    }
  }, [bytes, csv]);
  const sheet = parsed.sheets[Math.min(picked, Math.max(0, parsed.sheets.length - 1))];
  const capped = !!sheet && (sheet.total > SHEET_ROW_CAP || sheet.columns > SHEET_COLUMN_CAP);
  useEffect(() => {
    onCapped?.(capped);
  }, [capped, onCapped]);

  if (parsed.failed) return <p className="ck-file-note" role="alert">{t('files.sheetFailed')}</p>;
  if (!sheet) return <p className="ck-file-note">{t('files.sheetEmpty')}</p>;
  return (
    <div className="ck-xl" data-testid="file-sheet">
      {parsed.sheets.length > 1 && (
        <div className="ck-xl-picker" role="tablist" aria-label={t('files.sheetPicker')}>
          {parsed.sheets.map((s, i) => (
            <button
              key={s.name}
              type="button"
              role="tab"
              aria-selected={i === picked}
              className={`ck-xl-tab${i === picked ? ' is-active' : ''}`}
              onClick={() => setPicked(i)}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      {sheet.rows.length === 0 ? (
        <p className="ck-file-note">{t('files.sheetEmpty')}</p>
      ) : (
        <div className="ck-xl-scroll">
          <table className="ck-xl-table">
            <tbody>
              {sheet.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (r === 0 ? <th key={c}>{cell}</th> : <td key={c}>{cell}</td>))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {capped && (
        <p className="ck-file-note" data-testid="file-sheet-capped">
          {t('files.sheetCapped', { rows: SHEET_ROW_CAP, columns: SHEET_COLUMN_CAP })}
        </p>
      )}
    </div>
  );
}
