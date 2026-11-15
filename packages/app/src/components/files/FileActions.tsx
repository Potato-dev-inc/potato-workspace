// The way out of a file that cannot be shown here: open it in its own program, or find it in the folder. A "too big"
// message is never a dead end.
import { useT } from '../../i18n';

export function FileActions({ openLabel, onOpen, onReveal }: { openLabel?: string; onOpen?: () => void; onReveal: () => void }) {
  const t = useT();
  return (
    <div className="ck-file-actions" data-testid="file-actions">
      {onOpen && (
        <button type="button" className="ck-btn ck-btn--primary ck-btn--sm" onClick={onOpen}>
          {openLabel ?? t('files.openDefault')}
        </button>
      )}
      <button type="button" className="ck-btn ck-btn--plain ck-btn--sm" onClick={onReveal}>
        {t('files.showInFolder')}
      </button>
    </div>
  );
}
