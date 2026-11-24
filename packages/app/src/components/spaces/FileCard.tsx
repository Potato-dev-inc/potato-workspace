import { formatSize, type SpaceFile } from '../../lib/spaces';
import { t } from '../../i18n';

export { formatSize };

export interface FileCardProps {
  file: SpaceFile;
  error: string | null;
  savedAs: string | null;
  onGet: () => void;
  onSave: () => void;
}

/** A file in a message. It only ever offers Get file and Save to Downloads: nothing opens or previews a file. */
export function FileCard({ file, error, savedAs, onGet, onSave }: FileCardProps) {
  return (
    <div className="ck-spaces-file">
      <p className="ck-spaces-file-name">{file.name} · {formatSize(file.size)}</p>
      {file.state === 'getting' ? (
        <p className="ck-spaces-hint" role="status">Getting file… {file.percent}%</p>
      ) : file.have ? (
        <button type="button" className="ck-spaces-btn" onClick={onSave}>{t('r21.sw.saveToDownloads')}</button>
      ) : (
        <button type="button" className="ck-spaces-btn" onClick={onGet}>{t('r21.sw.getFile')}</button>
      )}
      {savedAs && <p className="ck-spaces-hint" role="status">Saved to Downloads as {savedAs}.</p>}
      {error && <p className="ck-spaces-hint is-error" role="alert">{error}</p>}
      <p className="ck-spaces-hint">{t('r21.sw.filesFromOtherPeople')}</p>
    </div>
  );
}
