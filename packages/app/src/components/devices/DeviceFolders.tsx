// "Open shared folders here": which folders of THIS PC that device may look in. Project folders are shared by default;
// the person can add more folders or take them away again. The check happens in the backend, not here.
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { isFarError } from '../../lib/deviceFiles';
import { clipText, devicesApi, type Device, type DevicesApi, type FilesFolders } from '../../lib/devices';
import { errorSentence } from '../../lib/sayError';
import '../../styles/devices.css';

export function DeviceFolders({ device, api = devicesApi }: { device: Device; api?: DevicesApi }) {
  const t = useT();
  const [folders, setFolders] = useState<FilesFolders | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .filesFolders(device.node)
      .then((f) => live && setFolders({ shared: Array.isArray(f?.shared) ? f.shared : [], chosen: Array.isArray(f?.chosen) ? f.chosen : [] }))
      .catch((e: unknown) => live && setError(errorSentence(e)));
    return () => {
      live = false;
    };
  }, [api, device.node]);

  const save = (chosen: string[]) => {
    setError(null);
    api
      .setFilesFolders(device.node, chosen)
      .then((f) => {
        if (isFarError(f)) return setError(clipText((f as { error: string }).error, 300));
        setFolders({ shared: Array.isArray(f?.shared) ? f.shared : [], chosen: Array.isArray(f?.chosen) ? f.chosen : chosen });
      })
      .catch((e: unknown) => setError(errorSentence(e)));
  };
  const add = async () => {
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked !== 'string' || picked === '') return;
      const chosen = folders?.chosen ?? [];
      if (!chosen.includes(picked)) save([...chosen, picked]);
    } catch {
      /* the dialog was closed */
    }
  };

  return (
    <div className="dev-folders" data-testid="device-folders">
      <p className="dev-note">{t('devices.folders.default')}</p>
      <ul className="dev-list">
        {(folders?.shared ?? []).map((name) => (
          <li key={`s:${name}`} className="dev-folder" data-testid="folder-shared">
            <span className="dev-grow">{clipText(name, 120)}</span>
          </li>
        ))}
        {(folders?.chosen ?? []).map((p) => (
          <li key={`c:${p}`} className="dev-folder" data-testid="folder-chosen">
            <span className="dev-grow">{clipText(p, 300)}</span>
            <button type="button" className="dev-btn is-plain" onClick={() => save((folders?.chosen ?? []).filter((x) => x !== p))} data-testid="folder-remove">
              {t('devices.folders.remove')}
            </button>
          </li>
        ))}
      </ul>
      <div className="dev-row">
        <button type="button" className="dev-btn" onClick={() => void add()} data-testid="folder-add">
          {t('devices.folders.add')}
        </button>
      </div>
      {error && (
        <p className="dev-error" role="alert" data-testid="folders-error">
          {error}
        </p>
      )}
    </div>
  );
}
