// Changes: what the agent changed in this chat. A totals row, the four most changed files, "Done means" as one row,
// and one line of buttons. A file whose only change is line endings shows that in words and is left out of the totals.
import { useState } from 'react';
import { useT } from '../../../i18n';
import { openFileTab } from '../../../lib/file-tabs';
import type { OutputFile } from '../../../lib/sessionChatModel';
import { keepFile, useReviewMarks, useTurnReview, type ReviewFile } from '../../../lib/turn-review';
import { dragSourceProps } from '../../dnd/dragSourceProps';
import { DoneList } from '../DoneList';
import { ThenSheet } from '../routines/ThenSheet';
import { FileGlyph } from './FileGlyph';
import { RailSection } from './RailSection';
import { baseName, relativeTo, withCommas, writtenFiles } from './railFormat';

const SHOWN = 4;

export interface ChangeRow {
  path: string;
  status: string;
  added: number;
  deleted: number;
  /** Only the line endings changed: no numbers, not in the totals. */
  lineEndingsOnly: boolean;
}

export interface ChangeTotals {
  files: number;
  added: number;
  deleted: number;
}

/** Totals over every row; a line-endings-only file counts as a file but adds no lines. */
export function changeTotals(rows: readonly ChangeRow[]): ChangeTotals {
  let added = 0;
  let deleted = 0;
  for (const r of rows) {
    if (r.lineEndingsOnly) continue;
    added += r.added;
    deleted += r.deleted;
  }
  return { files: rows.length, added, deleted };
}

/** The most changed files first; line-endings-only files go last. */
export function topChanges(rows: readonly ChangeRow[]): ChangeRow[] {
  const weight = (r: ChangeRow) => (r.lineEndingsOnly ? -1 : r.added + r.deleted);
  return [...rows].sort((a, b) => weight(b) - weight(a));
}

/** Rows from the last turn's review; or, with no review yet, from the files the chat says the agent wrote. */
export function changeRows(review: readonly (ReviewFile & { lineEndingsOnly?: boolean })[], outputs: readonly OutputFile[]): ChangeRow[] {
  if (review.length > 0) {
    return review.map((f) => ({ path: f.path, status: f.status, added: f.added, deleted: f.deleted, lineEndingsOnly: f.lineEndingsOnly === true }));
  }
  return writtenFiles(outputs).map((f) => ({ path: f.path, status: 'M', added: 0, deleted: 0, lineEndingsOnly: false }));
}

export function Numbers({ added, deleted }: { added: number; deleted: number }) {
  return (
    <span className="rp-num">
      {added > 0 && <span className="rp-add">+{withCommas(added)}</span>}
      {added > 0 && deleted > 0 && ' '}
      {deleted > 0 && <span className="rp-del">−{withCommas(deleted)}</span>}
    </span>
  );
}

export function ChangesSection({
  paneId,
  status,
  cwd,
  outputs,
  canCreatePr,
  showDone,
  onOpenChanges,
  onNotify,
}: {
  paneId: string;
  status: string;
  cwd: string;
  outputs: readonly OutputFile[];
  /** The chat works on a copy of a git project, so a pull request can be made from its Changes tab. */
  canCreatePr: boolean;
  /** Show the "Done means" row (the chat is an agent chat that reads its session). */
  showDone: boolean;
  onOpenChanges?: () => void;
  onNotify?: (text: string) => void;
}) {
  const t = useT();
  const { load } = useTurnReview(paneId, status);
  useReviewMarks();
  const [thenOpen, setThenOpen] = useState(false);
  const reviewFiles = load.state === 'ready' ? load.review.files : [];
  const rows = changeRows(reviewFiles, outputs);
  const totals = changeTotals(rows);
  const top = topChanges(rows).slice(0, SHOWN);
  const empty = rows.length === 0;

  const rowLabel = (n: number) => t('rail.chg.files', { count: n, n });
  const summary = empty ? t('rail.chg.noneSummary') : <Numbers added={totals.added} deleted={totals.deleted} />;

  return (
    <RailSection id="chg" title={t('rail.chg.title')} summary={summary}>
      {empty ? (
        <div className="rp-row is-empty">{t('rail.chg.none')}</div>
      ) : (
        <>
          <div className="rp-row" data-testid="rail-changes-total">
            <span className="rp-k">{rowLabel(totals.files)}</span>
            <span className="rp-v">
              <Numbers added={totals.added} deleted={totals.deleted} />
            </span>
          </div>
          {top.map((row) => (
            <button
              key={row.path}
              type="button"
              className="rp-row rp-btn"
              title={row.path}
              onClick={() => (onOpenChanges ? onOpenChanges() : openFileTab(paneId, relativeTo(cwd, row.path)))}
              {...dragSourceProps({ kind: 'file', id: row.path, label: baseName(row.path), meta: { abs: row.path } })}
            >
              <span className={`rp-mk is-${row.status.toLowerCase()}`}>{row.status.charAt(0)}</span>
              <FileGlyph name={row.path} />
              <span className="rp-name">{baseName(row.path)}</span>
              {row.lineEndingsOnly ? <span className="rp-v is-dim rp-small">{t('rail.chg.lineEndings')}</span> : <Numbers added={row.added} deleted={row.deleted} />}
            </button>
          ))}
          {rows.length > SHOWN && onOpenChanges && (
            <button type="button" className="rp-row rp-more" onClick={onOpenChanges}>
              {t('rail.chg.showAll', { n: rows.length })}
            </button>
          )}
        </>
      )}
      {showDone && <DoneList paneId={paneId} cwd={cwd} rail />}
      {!empty && (
        <div className="rp-acts">
          {onOpenChanges && (
            <button type="button" className="rp-btn-pri" onClick={onOpenChanges}>
              {t('rail.chg.review')}
            </button>
          )}
          {reviewFiles.length > 0 && (
            <button type="button" className="rp-btn-sec" onClick={() => reviewFiles.forEach((f) => keepFile(paneId, f))}>
              {t('rail.chg.keepAll')}
            </button>
          )}
          {canCreatePr && onOpenChanges && (
            <button type="button" className="rp-btn-sec" onClick={onOpenChanges}>
              {t('rail.chg.createPr')}
            </button>
          )}
          {showDone && (
            <button type="button" className="rp-btn-plain" onClick={() => setThenOpen(true)}>
              {t('rail.chg.then')}
            </button>
          )}
        </div>
      )}
      {thenOpen && (
        <ThenSheet
          paneId={paneId}
          cwd={cwd}
          onClose={() => setThenOpen(false)}
          onAdded={() => {
            setThenOpen(false);
            onNotify?.(t('routines.then.added'));
          }}
        />
      )}
    </RailSection>
  );
}
