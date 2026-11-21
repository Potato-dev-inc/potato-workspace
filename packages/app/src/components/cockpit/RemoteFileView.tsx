// A file of a project on another computer (SSH), shown READ ONLY in the file tab. The text came from the far machine: it is shown
// as plain text in a <pre> (never as markup), already stripped of terminal escapes by the backend, and no edit or save exists here.
import { useT } from '../../i18n';
import { farErrorText, sizeWords, useFar, useTurnEnds, remoteFsApi, type RemoteFsApi } from '../../lib/remoteFs';
import '../../styles/files.css';

export function RemoteFileView({ paneId, path, name, status, api = remoteFsApi }: { paneId: string; path: string; name: string; /** The chat's status: the file is read again when a turn ends. */ status: string; api?: RemoteFsApi }) {
  const t = useT();
  const turnEnds = useTurnEnds(status);
  const { value, reload } = useFar((fresh) => api.read(paneId, path, fresh), turnEnds, [paneId, path, api]);
  const size = value.state === 'ready' ? sizeWords(value.data.size) : null;
  return (
    <div className="ck-scroll ck-rfile" data-testid="remote-file">
      <div className="ck-rfile-head">
        <span className="ck-rfile-path" title={path}>
          {path}
        </span>
        {size && <span className="ck-rfile-size">{t(size.key, size.vars)}</span>}
        <button type="button" className="ck-rfile-btn" onClick={reload} data-testid="remote-file-refresh">
          {t('devices.ssh.fs.refresh')}
        </button>
      </div>
      <p className="ck-sub">{t('devices.ssh.fs.fileNote', { name })}</p>
      {value.state === 'loading' && <p className="ck-sub">{t('devices.ssh.fs.loading', { name })}</p>}
      {value.state === 'error' && (
        <div role="alert" data-testid="remote-file-error">
          <p className="ck-sub">{farErrorText(value, name)}</p>
          <button type="button" className="ck-rfile-btn" onClick={reload}>
            {t('devices.ssh.fs.retry')}
          </button>
        </div>
      )}
      {value.state === 'ready' && (
        <pre className="ck-rfile-text" tabIndex={0} data-testid="remote-file-text">
          {value.data.text}
        </pre>
      )}
    </div>
  );
}
