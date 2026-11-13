// The "Restore ...?" confirmation: what a restore does, the safety copy, and (when another agent
// works in the same folder) the shared-folder warning. Used by the History tab and by the palette's
// "Undo last turn", so every way to restore asks the same question.
import { useT } from '../../i18n';
import { sharedFolderWarning } from './history-model';
import { Sheet } from './Sheet';

export function RestoreSheet({
  title,
  confirmLabel,
  sharedWith = [],
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  confirmLabel?: string;
  /** Labels of the other live panes working in this pane's folder. */
  sharedWith?: string[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const warning = sharedFolderWarning(sharedWith);
  return (
    <Sheet labelledBy="ck-restore-t" onClose={busy ? undefined : onCancel}>
        <h2 className="ck-section" id="ck-restore-t">
          {title}
        </h2>
        <p className="ck-sub">
          {t('risk.restore.body')}
        </p>
        <p className="ck-sub">{t('risk.restore.safe')}</p>
        {warning && <p className="ck-sub">{warning}</p>}
        <div className="ck-sheet-actions">
          <button type="button" className="ck-btn ck-btn--secondary" autoFocus disabled={busy} onClick={onCancel}>
            {t('risk.restore.cancel')}
          </button>
          <button type="button" className="ck-btn ck-btn--primary" disabled={busy} onClick={onConfirm}>
            {busy ? t('risk.restore.busy') : (confirmLabel ?? t('risk.restore.confirm'))}
          </button>
        </div>
    </Sheet>
  );
}
