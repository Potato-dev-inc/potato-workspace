// Shown above the editor when the file changed on disk while there were unsaved changes: take the disk version
// (Reload) or write mine over it (Keep mine). Nothing is lost without a click.
import { useT } from '../../i18n';

export function ConflictBar({ onReload, onKeepMine, busy }: { onReload: () => void; onKeepMine: () => void; busy?: boolean }) {
  const t = useT();
  return (
    <div className="ck-fconflict" role="alert" data-testid="file-conflict">
      <span className="ck-fconflict-text">
        <strong>{t('files.conflictTitle')}</strong> {t('files.conflictBody')}
      </span>
      <button type="button" className="ck-btn ck-btn--secondary ck-btn--sm" disabled={busy} onClick={onReload}>
        {t('files.reload')}
      </button>
      <button type="button" className="ck-btn ck-btn--plain ck-btn--sm" disabled={busy} onClick={onKeepMine}>
        {t('files.keepMine')}
      </button>
    </div>
  );
}
