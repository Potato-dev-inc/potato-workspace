// Changes: what the agent changed in this chat. A totals row, the four most changed files, "Done means" as one row,
// and one line of buttons. A file whose only change is line endings shows that in words and is left out of the totals.
import { useEffect, useState } from 'react';
import { cockpitApi, type WorktreeItem } from '../../../lib/cockpit-api';
import { errorCode, errorSentence } from '../../../lib/sayError';
import { plainMergeError } from '../Changes';
import { useT } from '../../../i18n';
import { useHost } from '../../../lib/host/context';
import { openFileTab } from '../../../lib/file-tabs';
import type { OutputFile } from '../../../lib/sessionChatModel';
import { dropStaleDecisions, isPutBack, keepFile, stateOf, useReviewMarks, useTurnReview, type ReviewFile } from '../../../lib/turn-review';
import { dragSourceProps } from '../../dnd/dragSourceProps';
import { DoneList } from '../DoneList';
import { useWorktreeApi } from '../usePaneWorktree';
import { ThenSheet } from '../routines/ThenSheet';
import { FileGlyph } from './FileGlyph';
import { RailSection } from './RailSection';
import { baseName, insideProject, relativeTo, withCommas, writtenFiles } from './railFormat';

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
  // The chat's write events cannot say whether a file is new or edited: no letter until the review knows.
  return writtenFiles(outputs).map((f) => ({ path: f.path, status: '', added: 0, deleted: 0, lineEndingsOnly: false }));
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
  worktree = null,
  mergeApi: givenMerge,
  turnKey = '',
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
  /** The chat works on a copy: Keep all merges the copy into the project. Null: the chat works in the project itself. */
  worktree?: WorktreeItem | null;
  mergeApi?: Pick<typeof cockpitApi, 'worktreeMerge'>;
  /** Changes when the chat's turns do (a count, the last turn's end). A far chat's status is only sampled, so a short turn can pass with the status unchanged: the review is read again on this too. */
  turnKey?: string;
}) {
  const t = useT();
  const local = useHost().place.kind === 'local';
  const ownApi = useWorktreeApi(paneId);
  const mergeApi: Pick<typeof cockpitApi, 'worktreeMerge'> = givenMerge ?? ownApi;
  const { load } = useTurnReview(paneId, `${status}|${turnKey}`, undefined, status !== 'running');
  useReviewMarks();
  const [thenOpen, setThenOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [keepError, setKeepError] = useState<string | null>(null);
  const turnFiles = load.state === 'ready' ? load.review.files : [];
  useEffect(() => dropStaleDecisions(paneId, turnFiles), [paneId, turnFiles]);
  // A file put back is no longer a change (its Undo brings it back); the chat's write events still name it, so they are filtered too.
  const reviewFiles = turnFiles.filter((f) => stateOf(paneId, f).decision !== 'back');
  const rows = changeRows(reviewFiles, outputs.filter((o) => (!local || insideProject(cwd, o.path)) && !isPutBack(paneId, relativeTo(cwd, o.path), o.at ?? null)));
  const totals = changeTotals(rows);
  const top = topChanges(rows).slice(0, SHOWN);
  const empty = rows.length === 0;
  const keptPaths = new Set(reviewFiles.filter((f) => stateOf(paneId, f).decision === 'kept').map((f) => f.path));
  const allKept = reviewFiles.length > 0 && keptPaths.size === reviewFiles.length;

  /** Marks every file of the turn as kept: the same Keep as Review's file-by-file list. */
  const markAllKept = () => reviewFiles.forEach((f) => keepFile(paneId, f));
  const keepAll = async () => {
    setKeepError(null);
    if (!worktree) {
      markAllKept();
      return;
    }
    setBusy(true);
    try {
      const out = await mergeApi.worktreeMerge(worktree.repo, worktree.handle);
      markAllKept();
      onNotify?.(out.merged ? t('rail.chg.keptInto', { into: out.into ?? worktree.base }) : t('rail.chg.keepNothing'));
    } catch (e) {
      const said = errorSentence(e);
      const withCode = `${errorCode(e) ?? ''} ${said}`;
      const plain = plainMergeError(withCode);
      setKeepError(plain.text === withCode ? said : plain.text);
    } finally {
      setBusy(false);
      setAsking(false);
    }
  };

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
              {row.status && <span className={`rp-mk is-${row.status.toLowerCase()}`}>{row.status.charAt(0)}</span>}
              <FileGlyph name={row.path} />
              <span className="rp-name">{baseName(row.path)}</span>
              {row.lineEndingsOnly ? <span className="rp-v is-dim rp-small">{t('rail.chg.lineEndings')}</span> : <Numbers added={row.added} deleted={row.deleted} />}
              {keptPaths.has(row.path) && (
                <span className="rp-v is-ok rp-small" data-testid="rail-row-kept">
                  {t('rail.chg.kept')}
                </span>
              )}
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
          {reviewFiles.length > 0 &&
            (allKept ? (
              <span className="rp-v is-ok rp-small rp-kept-all" role="status">
                {t('rail.chg.kept')}
              </span>
            ) : (
              <button type="button" className="rp-btn-sec" disabled={busy} onClick={() => (worktree ? setAsking(true) : void keepAll())}>
                {t('rail.chg.keepAll')}
              </button>
            ))}
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
      {asking && worktree && (
        <div className="rp-row rp-ask-row" role="group" aria-label={t('rail.chg.keepAsk', { count: reviewFiles.length, n: reviewFiles.length, base: worktree.base })}>
          <span className="rp-name">{t('rail.chg.keepAsk', { count: reviewFiles.length, n: reviewFiles.length, base: worktree.base })}</span>
          <button type="button" className="rp-mini" disabled={busy} onClick={() => void keepAll()}>
            {t('rail.chg.keepYes')}
          </button>
          <button type="button" className="rp-mini" disabled={busy} onClick={() => setAsking(false)}>
            {t('rail.chg.keepNo')}
          </button>
        </div>
      )}
      {keepError && (
        <p className="rp-note" role="alert">
          {keepError}
        </p>
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
