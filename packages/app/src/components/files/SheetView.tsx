// A spreadsheet (.xlsx, .xls, .csv) as a table: the first sheet, a picker for the others, and a cap on rows and
// columns so a huge file cannot freeze the app. SheetJS (community build) reads it in a worker (`office-client.ts`)
// and is its own chunk, loaded on first open.
import { useEffect, useState, type ReactNode } from 'react';
import { useT } from '../../i18n';
import type { FileSource } from '../../lib/files-api';
import { openSheets } from './office-client';
import { SHEET_COLUMN_CAP, SHEET_ROW_CAP, type Sheet } from './sheet-read';
import { SheetTable } from './SheetTable';

export { SHEET_COLUMN_CAP, SHEET_ROW_CAP, readSheets } from './sheet-read';

type Parsed = { sheets: Sheet[]; failed: boolean; loading: boolean };

export function SheetView({ source, csv, onCapped, actions }: { source: FileSource; csv: boolean; onCapped?: (capped: boolean) => void; actions?: ReactNode }) {
  const t = useT();
  const [picked, setPicked] = useState(0);
  const [parsed, setParsed] = useState<Parsed>({ sheets: [], failed: false, loading: true });
  useEffect(() => {
    let cancelled = false;
    setParsed({ sheets: [], failed: false, loading: true });
    setPicked(0);
    const job = openSheets(source, csv);
    job.sheets.then(
      (sheets) => !cancelled && setParsed({ sheets, failed: false, loading: false }),
      () => !cancelled && setParsed({ sheets: [], failed: true, loading: false }),
    );
    return () => {
      cancelled = true;
      job.stop();
    };
  }, [source, csv]);
  const sheet = parsed.sheets[Math.min(picked, Math.max(0, parsed.sheets.length - 1))];
  const capped = !!sheet && (sheet.total > SHEET_ROW_CAP || sheet.columns > SHEET_COLUMN_CAP);
  useEffect(() => {
    onCapped?.(capped);
  }, [capped, onCapped]);

  if (parsed.loading) return <p className="ck-file-note">{t('files.loading')}</p>;
  if (parsed.failed) {
    return (
      <>
        <p className="ck-file-note" role="alert">{t('files.sheetFailed')}</p>
        {actions}
      </>
    );
  }
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
          <SheetTable sheet={sheet} />
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
