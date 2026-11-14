// Files the agent wrote in this session (not the ones it only read). A click opens the pane's Changes tab when
// it has one; otherwise the list is just a list.
import type { OutputFile } from '../../../lib/sessionChatModel';
import { useT } from '../../../i18n';
import { countsFor, stateOf, useReviewMarks, useTurnReview } from '../../../lib/turn-review';
import { counterParts } from '../turnfiles/TurnFiles';
import { RailCard } from './RailCard';
import { dragSourceProps } from '../../dnd/dragSourceProps';
import { baseName, fileFolder, filesCount, writtenFiles } from './railFormat';

const SHOWN = 8;

const slashes = (p: string) => p.split('\\').join('/');

/** `abs` relative to the project folder, with `/`; the path as it is when it is not inside. */
function relativeTo(cwd: string, abs: string): string {
  const root = slashes(cwd).replace(/[/]+$/, '');
  const path = slashes(abs);
  return path.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? path.slice(root.length + 1) : path;
}

export function ChangesCard({
  paneId,
  status,
  outputs,
  cwd,
  onOpenChanges,
}: {
  paneId: string;
  status: string;
  outputs: readonly OutputFile[];
  cwd: string;
  onOpenChanges?: () => void;
}) {
  const t = useT();
  const files = writtenFiles(outputs);
  const { load } = useTurnReview(paneId, status);
  useReviewMarks();
  if (files.length === 0) return null;
  // The last turn's review, when there is one: what is kept, put back and still left, and which files are looked at.
  const reviewFiles = load.state === 'ready' ? load.review.files : [];
  const counts = countsFor(paneId, reviewFiles);
  const byPath = new Map(reviewFiles.map((f) => [f.path, f]));
  const shown = files.slice(0, SHOWN);
  const rows = shown.map((file) => {
    const folder = fileFolder(file.path, cwd);
    const known = byPath.get(relativeTo(cwd, file.path));
    const st = known ? stateOf(paneId, known) : null;
    const word = st?.decision === 'kept' ? t('review.stateKept') : st?.decision === 'back' ? t('review.stateBack') : st?.look === 'changed' ? t('review.changedSince') : st?.look === 'looked' ? t('review.stateLooked') : null;
    const inner = (
      <>
        <span className="ck-rail-file">{baseName(file.path)}</span>
        {folder && <span className="ck-rail-folder">{folder}</span>}
        {word && <span className="ck-rail-folder">{word}</span>}
      </>
    );
    return (
      <li key={file.path}>
        {onOpenChanges ? (
          <button
            type="button"
            className="ck-rail-item"
            title={`${file.path}. Open Changes`}
            onClick={onOpenChanges}
            {...dragSourceProps({ kind: 'file', id: file.path, label: baseName(file.path), meta: { abs: file.path } })}
          >
            {inner}
          </button>
        ) : (
          <div className="ck-rail-item is-static" title={file.path} {...dragSourceProps({ kind: 'file', id: file.path, label: baseName(file.path), meta: { abs: file.path } })}>
            {inner}
          </div>
        )}
      </li>
    );
  });
  return (
    <RailCard title="Changes" note={filesCount(files.length)} testId="rail-changes">
      {reviewFiles.length > 0 && (
        <p className="ck-rail-line" data-testid="rail-review-line">
          {counterParts(t, counts)} · {t('review.lookedCount', { done: counts.looked, total: counts.total })}
        </p>
      )}
      {reviewFiles.length > 0 && onOpenChanges && (
        <button type="button" className="ck-rail-item" onClick={onOpenChanges} data-testid="rail-review-open">
          {t('review.cardOpen')}
        </button>
      )}
      <ul className="ck-rail-list">{rows}</ul>
      {files.length > SHOWN && <p className="ck-rail-more">and {files.length - SHOWN} more</p>}
    </RailCard>
  );
}
