// "Copy path" beside a note that says a file is on another PC. The path is the file's place inside its project, which is all this PC knows of it.
import { useT } from '../../i18n';

export function CopyPathButton({ path, onDone }: { path: string; onDone: (text: string) => void }) {
  const t = useT();
  const copy = () => {
    if (!navigator.clipboard) return onDone(t('files.copyFailed'));
    navigator.clipboard.writeText(path).then(
      () => onDone(t('files.copied')),
      () => onDone(t('files.copyFailed')),
    );
  };
  return (
    <button type="button" className="ck-btn ck-btn--plain ck-btn--sm" data-testid="copy-far-path" onClick={copy}>
      {t('files.menuCopy')}
    </button>
  );
}
