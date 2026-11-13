// Restoring files and the safety net around it, shared by the History tab and the "Undo last turn"
// palette action: one code path, so both show the same toast with an Undo that puts back what the
// restore replaced.
import { t } from '../../i18n';
import { errorSentence } from '../../lib/sayError';
import type { Checkpoint, CheckpointsApi, RestoreReport } from '../../lib/cockpit-api';
import { checkpointTitle } from './history-model';
import { markStep } from '../../lib/getting-started';

export interface ToastAction {
  label: string;
  run: () => void;
}

export type Notify = (text: string, action?: ToastAction) => void;

const errText = (e: unknown): string => (errorSentence(e));

/** Other words for the same toasts (Simple mode says "went back", never "restored"). */
export interface RestoreWords {
  restored: (target: Pick<Checkpoint, 'id' | 'label'>, report: RestoreReport) => string;
  undo: string;
  undone: string;
}

/**
 * Restore `target`, then say so. When the restore saved the current files first (`safetyId`, the
 * "Before undo" checkpoint), the toast carries an Undo that restores exactly that. Returns the
 * report, or null when the restore failed (the toast already says why).
 */
export async function restoreWithUndo(
  api: Pick<CheckpointsApi, 'checkpointRestore'>,
  paneId: string,
  target: Pick<Checkpoint, 'id' | 'label'>,
  notify: Notify,
  words?: RestoreWords,
): Promise<RestoreReport | null> {
  try {
    const report = await api.checkpointRestore(paneId, target.id);
    markStep('undo');
    const failed = report.failed.length ? t('risk.restore.failedFiles', { n: report.failed.length }) : '';
    const text = words ? words.restored(target, report) : t('risk.restore.done', { title: checkpointTitle(target), failed });
    const safetyId = report.safetyId;
    notify(
      text,
      safetyId
        ? {
            label: words?.undo ?? t('risk.restore.undo'),
            run: () => {
              api.checkpointRestore(paneId, safetyId).then(
                () => notify(words?.undone ?? t('risk.restore.undone')),
                (e) => notify(errText(e)),
              );
            },
          }
        : undefined,
    );
    return report;
  } catch (e) {
    notify(errText(e));
    return null;
  }
}
