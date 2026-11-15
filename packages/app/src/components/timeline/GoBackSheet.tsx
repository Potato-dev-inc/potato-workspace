// The confirm sheet for "Go back to here": which project and time, what would change, the memory sentence,
// whether the person's own git is touched, and a warning when other chats share the folder.
import { useT } from '../../i18n';
import type { NowDiff } from '../../lib/timeline';
import { sharedFolderWarning } from '../cockpit/history-model';
import { Sheet } from '../cockpit/Sheet';
import { backSummary } from './back-summary';

export function GoBackSheet({
  time,
  project,
  back,
  sharedWith,
  simple,
  busy,
  onCancel,
  onConfirm,
}: {
  time: string;
  project: string;
  back: NowDiff | undefined;
  /** Names of the other chats that work in this folder. */
  sharedWith: string[];
  simple: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const warning = sharedFolderWarning(sharedWith);
  return (
    <Sheet labelledBy="ck-tl-sheet-t" onClose={busy ? undefined : onCancel}>
      <h2 className="ck-section" id="ck-tl-sheet-t">
        {simple ? t('timeline.simple.sheetTitle', { time }) : t('timeline.sheet.title', { time, project })}
      </h2>
      {back && (
        <p className="ck-sub" data-testid="timeline-sheet-sum">
          {backSummary(back, t)}
        </p>
      )}
      <p className="ck-sub">{simple ? t('timeline.simple.sheetBody') : t('timeline.sheet.body')}</p>
      <p className="ck-sub">{t('timeline.sheet.safe')}</p>
      {back?.hasGit && <p className="ck-sub">{t('timeline.sheet.git')}</p>}
      {warning && <p className="ck-sub">{warning}</p>}
      <div className="ck-sheet-actions">
        <button type="button" className="ck-btn ck-btn--secondary" autoFocus disabled={busy} onClick={onCancel}>
          {t('timeline.sheet.cancel')}
        </button>
        <button type="button" className="ck-btn ck-btn--primary" disabled={busy} onClick={onConfirm}>
          {busy ? t('timeline.sheet.busy') : t('timeline.sheet.confirm')}
        </button>
      </div>
    </Sheet>
  );
}
