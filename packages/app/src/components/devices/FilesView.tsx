// Files of one device: its shared folders (the far device decides which), a breadcrumb, a table, a preview of text and
// pictures, Copy to this PC and Send a file there. Every name and every error that comes from the far device is
// untrusted text. An error is shown as the far device words it; nothing is judged here beforehand.
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { dateText, isFarError, joinPath, pickRoot, sizeText } from '../../lib/deviceFiles';
import { clipText, devicesApi, type Device, type DevicesApi, type FileEntry, type FilePreview } from '../../lib/devices';
import { errorSentence } from '../../lib/sayError';
import { ExistsQuestion, Transfers } from './TransferRow';
import { useFileOps } from './useFileOps';
import '../../styles/devices.css';

type Preview = { name: string; path: string; data: FilePreview | null; error: string | null };

export function FilesView({ device, api = devicesApi, startAt, onClose }: { device: Device; api?: DevicesApi; startAt?: { folderName?: string; path?: string }; onClose?: () => void }) {
  const t = useT();
  const node = device.node;
  const [roots, setRoots] = useState<string[] | null>(null);
  const [root, setRoot] = useState('');
  const [path, setPath] = useState(startAt?.path ?? '');
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<Preview | null>(null);
  const ops = useFileOps();
  const token = useRef(0);
  const previewToken = useRef(0);

  // The far device's folder names, once.
  useEffect(() => {
    let live = true;
    setRoots(null);
    setError(null);
    api
      .filesRoots(node)
      .then((r) => {
        if (!live) return;
        if (isFarError(r)) return setError(clipText(r.error, 300) || '?');
        const names = (Array.isArray(r.roots) ? r.roots : []).filter((x) => typeof x === 'string');
        setRoots(names);
        const first = pickRoot(names, startAt?.folderName ?? '');
        if (first !== null) setRoot(first);
      })
      .catch((e: unknown) => live && setError(errorSentence(e)));
    return () => {
      live = false;
    };
    // The start place is read once, when the view opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, node]);

  const load = (r: string, p: string) => {
    const mine = ++token.current;
    setEntries(null);
    setError(null);
    setPicked(new Set());
    previewToken.current++;
    setPreview(null);
    api
      .filesList(node, r, p)
      .then((res) => {
        if (mine !== token.current) return;
        if (isFarError(res)) return setError(clipText(res.error, 300) || '?');
        setEntries((Array.isArray(res.entries) ? res.entries : []).filter((e) => e && typeof e.name === 'string'));
        setTruncated(res.truncated === true);
      })
      .catch((e: unknown) => mine === token.current && setError(errorSentence(e)));
  };
  useEffect(() => {
    if (root !== '') load(root, path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, node, root, path]);

  const parts = useMemo(() => (path === '' ? [] : path.split('/')), [path]);
  const sorted = useMemo(() => (entries ?? []).slice().sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'dir' ? -1 : 1)), [entries]);

  const showPreview = (e: FileEntry) => {
    const p = joinPath(path, e.name);
    const mine = ++previewToken.current;
    setPreview({ name: e.name, path: p, data: null, error: null });
    api
      .filesPreview(node, root, p)
      .then((res) => {
        if (mine !== previewToken.current) return;
        if (isFarError(res)) return setPreview({ name: e.name, path: p, data: null, error: clipText(res.error, 300) || '?' });
        setPreview({ name: e.name, path: p, data: res, error: null });
      })
      .catch((err: unknown) => mine === previewToken.current && setPreview({ name: e.name, path: p, data: null, error: errorSentence(err) }));
  };

  const toggle = (name: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const copyPaths = picked.size > 0 ? [...picked].map((n) => joinPath(path, n)) : preview ? [preview.path] : [];
  const copy = () => {
    const paths = copyPaths;
    if (paths.length === 0) return;
    ops.run((mode) => api.filesCopy({ node, root, paths, on_exists: mode }));
  };
  const send = async (directory: boolean) => {
    try {
      const chosen = await openDialog({ multiple: true, directory });
      const local = (Array.isArray(chosen) ? chosen : chosen ? [chosen] : []).filter((x): x is string => typeof x === 'string');
      if (local.length === 0) return;
      ops.run((mode) => api.filesSend({ node, root, dir: path, local, on_exists: mode }));
    } catch {
      /* the dialog was closed */
    }
  };

  return (
    <section className="dev-files" data-testid="files-view" aria-label={t('devices.files.title', { name: clipText(device.name, 40) })}>
      <div className="dev-row">
        {onClose && (
          <button type="button" className="dev-btn is-plain" onClick={onClose} data-testid="files-back">
            ‹ {t('devices.back')}
          </button>
        )}
        <h4 className="dev-grow">{t('devices.files.title', { name: clipText(device.name, 40) })}</h4>
      </div>
      {roots !== null && roots.length > 1 && (
        <label className="dev-field">
          <span>{t('devices.files.root')}</span>
          <select
            value={root}
            onChange={(e) => {
              setRoot(e.target.value);
              setPath('');
            }}
            data-testid="files-root"
          >
            {roots.map((r) => (
              <option key={r} value={r}>
                {clipText(r, 80)}
              </option>
            ))}
          </select>
        </label>
      )}
      {error !== null && (
        <p className="dev-error" role="alert" data-testid="files-error">
          {error}
        </p>
      )}
      {roots !== null && roots.length === 0 && error === null && (
        <p className="dev-note" data-testid="files-no-roots">
          {t('devices.files.noRoots', { name: clipText(device.name, 40) })}
        </p>
      )}
      {root !== '' && (
        <>
          <nav className="dev-crumbs" aria-label={t('devices.files.path')} data-testid="files-crumbs">
            <button type="button" className="dev-btn is-plain" onClick={() => setPath('')} disabled={parts.length === 0}>
              {clipText(root, 80)}
            </button>
            {parts.map((part, i) => (
              <span key={i}>
                <span aria-hidden="true"> / </span>
                <button type="button" className="dev-btn is-plain" onClick={() => setPath(parts.slice(0, i + 1).join('/'))} disabled={i === parts.length - 1}>
                  {clipText(part, 80)}
                </button>
              </span>
            ))}
          </nav>
          <div className="dev-row">
            <button type="button" className="dev-btn is-primary" disabled={copyPaths.length === 0 || ops.busy} onClick={copy} data-testid="files-copy">
              {t('devices.files.copy')}
            </button>
            <button type="button" className="dev-btn" disabled={ops.busy} onClick={() => void send(false)} data-testid="files-send">
              {t('devices.files.send')}
            </button>
            <button type="button" className="dev-btn" disabled={ops.busy} onClick={() => void send(true)} data-testid="files-send-folder">
              {t('devices.files.sendFolder')}
            </button>
          </div>
          <ExistsQuestion ops={ops} />
          {ops.error && (
            <p className="dev-error" role="alert" data-testid="files-op-error">
              {ops.error}
            </p>
          )}
          {entries === null && error === null ? (
            <p className="dev-note" data-testid="files-loading">
              {t('devices.files.loading')}
            </p>
          ) : entries !== null && sorted.length === 0 ? (
            <p className="dev-note" data-testid="files-empty">
              {t('devices.files.empty')}
            </p>
          ) : (
            entries !== null && (
              <table className="dev-table" data-testid="files-table">
                <thead>
                  <tr>
                    <th aria-label={t('devices.files.pick')} />
                    <th>{t('devices.files.name')}</th>
                    <th>{t('devices.files.size')}</th>
                    <th>{t('devices.files.changed')}</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((e) => (
                    <tr key={e.name} data-testid={`file-row-${e.name}`}>
                      <td>
                        <input type="checkbox" checked={picked.has(e.name)} onChange={() => toggle(e.name)} aria-label={t('devices.files.select', { name: clipText(e.name, 80) })} data-testid={`file-pick-${e.name}`} />
                      </td>
                      <td>
                        <button type="button" className="dev-link" onClick={() => (e.kind === 'dir' ? setPath(joinPath(path, e.name)) : showPreview(e))} data-testid={`file-open-${e.name}`}>
                          {e.kind === 'dir' ? '▸ ' : ''}
                          {clipText(e.name, 120)}
                        </button>
                      </td>
                      <td>{e.kind === 'dir' ? '' : sizeText(e.size)}</td>
                      <td>{dateText(e.mtime)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}
          {truncated && <p className="dev-note">{t('devices.files.truncated')}</p>}
        </>
      )}
      {preview && <PreviewPane preview={preview} onClose={() => setPreview(null)} />}
      <Transfers api={api} node={node} />
    </section>
  );
}

function PreviewPane({ preview, onClose }: { preview: Preview; onClose: () => void }) {
  const t = useT();
  const d = preview.data;
  return (
    <div className="dev-preview" data-testid="files-preview">
      <div className="dev-row">
        <b className="dev-grow">{clipText(preview.name, 120)}</b>
        <button type="button" className="dev-btn is-plain" onClick={onClose} data-testid="preview-close">
          {t('devices.files.closePreview')}
        </button>
      </div>
      {preview.error !== null ? (
        <p className="dev-error" role="alert" data-testid="preview-error">
          {preview.error}
        </p>
      ) : d === null ? (
        <p className="dev-note">{t('devices.files.loading')}</p>
      ) : d.kind === 'text' ? (
        <>
          <pre className="dev-preview-text" data-testid="preview-text">
            {String(d.text ?? '')}
          </pre>
          {d.truncated && <p className="dev-note">{t('devices.files.previewCut')}</p>}
        </>
      ) : d.kind === 'image' && /^image\/[a-z0-9.+-]{1,30}$/i.test(d.mime) ? (
        <img className="dev-preview-img" alt={clipText(preview.name, 120)} src={`data:${d.mime};base64,${String(d.data).replace(/[^A-Za-z0-9+/=]/g, '')}`} data-testid="preview-image" />
      ) : (
        <p className="dev-note" data-testid="preview-none">
          {d.kind === 'none' && d.too_big ? t('devices.files.tooBig', { size: sizeText(d.size) }) : t('devices.files.noPreview', { size: sizeText(typeof d.size === 'number' ? d.size : 0) })}
        </p>
      )}
    </div>
  );
}
