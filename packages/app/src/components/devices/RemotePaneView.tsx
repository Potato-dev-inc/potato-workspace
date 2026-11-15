// A chat or a terminal that runs on another device, opened from the sidebar. The chat is the phone's own chat view (the same
// view, fed by the far bridge through the PC link); the terminal is a simple live screen (the far side pushes the text the
// moment it changes), with a line to type into when the device lets this PC type. The far device enforces its rights: this view only hides buttons.
// A device that goes away leaves the last text on screen and says so (nothing lived on this side, so nothing is lost).
import { useEffect, useMemo, useState } from 'react';
import { useT } from '../../i18n';
import { chipText, clipText, devicesApi, deviceNotices, requestError, type Device, type DevicesApi } from '../../lib/devices';
import { errorSentence } from '../../lib/sayError';
import { makeRemoteClient } from '../../lib/runtime/remote';
import { PhoneChatView } from '../mobile/PhoneChatView';
import { lastPart } from '../../lib/deviceFiles';
import { DeviceNotices } from './DeviceNotices';
import { FilesView } from './FilesView';
import { GetItCard } from './GetItCard';
import type { RemoteRow } from './useDeviceGroups';
import '../../styles/devices.css';

export function RemotePaneView({ device, row, api = devicesApi, onRetry }: { device: Device; row: Pick<RemoteRow, 'paneId' | 'chat' | 'title'> & Partial<Pick<RemoteRow, 'agent' | 'cwd'>>; api?: DevicesApi; onRetry?: () => void }) {
  const t = useT();
  const bridge = useMemo(() => makeRemoteClient(device.node, api), [device.node, api]);
  const canType = device.state === 'online' && device.level === 'full';
  const chip = chipText(device);
  const [showFiles, setShowFiles] = useState(false);
  const folderName = lastPart(row.cwd ?? '');
  return (
    <section className="dev-remote" data-testid="remote-pane" aria-label={device.name}>
      <header className="dev-remote-head">
        <span className={`dev-dot${device.state === 'online' ? ' is-up' : ''}`} aria-hidden="true" />
        <span>{row.chat ? t('devices.remote.chatTitle', { name: device.name }) : t('devices.remote.terminalTitle', { name: device.name })}</span>
        {chip && <span className="dev-chip">{chip}</span>}
        {!showFiles && (
          <button type="button" className="dev-btn is-plain dev-remote-folder" onClick={() => setShowFiles(true)} data-testid="open-remote-folder">
            {t('devices.files.openFolder', { name: clipText(device.name, 40) })}
          </button>
        )}
      </header>
      <DeviceNotices notices={deviceNotices(device, row.agent ? [row.agent] : undefined)} onRetry={onRetry} />
      {device.state === 'offline' && <p className="dev-remote-note">{t('devices.remote.offline', { name: device.name })}</p>}
      {device.level === 'watch' && device.state === 'online' && <p className="dev-note" style={{ padding: '6px 14px' }}>{t('devices.remote.watchOnly', { name: device.name })}</p>}
      <div className="dev-remote-body">
        {showFiles ? (
          <FilesView device={device} api={api} startAt={{ folderName }} onClose={() => setShowFiles(false)} />
        ) : row.chat ? (
          // The chat is the phone's view and its styles live under `.ph` (the phone shell), so it needs that class here too.
          <div className="ph dev-remote-ph" data-testid="remote-chat-scope">
            <PhoneChatView
              key={row.paneId}
              bridge={bridge}
              paneId={row.paneId}
              canWatch={device.state !== 'not_allowed'}
              canType={canType}
              link={device.state === 'online' ? 'connected' : 'offline'}
              acp
              canControl={canType}
            />
          </div>
        ) : (
          <RemoteScreen device={device} paneId={row.paneId} api={api} canType={canType} />
        )}
      </div>
      {row.chat && !showFiles && <GetItCard device={device} paneId={row.paneId} cwd={row.cwd} api={api} />}
    </section>
  );
}

function RemoteScreen({ device, paneId, api, canType }: { device: Device; paneId: string; api: DevicesApi; canType: boolean }) {
  const t = useT();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [line, setLine] = useState('');
  const online = device.state === 'online';
  // Live: the far side pushes the screen text the moment it changes (the first frame right after start). If it cannot
  // start, one snapshot is read instead.
  useEffect(() => {
    if (!online) return;
    let live = true;
    let off: (() => void) | undefined;
    let started = false;
    const snapshot = () =>
      api
        .request(device.node, 'GET', `/panes/${encodeURIComponent(paneId)}/snapshot`)
        .then((res) => {
          if (!live) return;
          if (res.status === 404) return setError(t('devices.remote.gone', { name: device.name }));
          if (res.status >= 300) return setError(requestError(device.name, res));
          setError(null);
          const content = (res.body as { content?: unknown } | null)?.content;
          setText(typeof content === 'string' ? content : '');
        })
        .catch((e: unknown) => live && setError(errorSentence(e)));
    api
      .onScreen((f) => {
        if (!live || f.node !== device.node || f.pane_id !== paneId) return;
        setError(null);
        setText(typeof f.content === 'string' ? f.content : '');
      })
      .then((stop) => {
        if (!live) return stop();
        off = stop;
        started = true;
        return api.screenStart(device.node, paneId);
      })
      .catch(() => void snapshot());
    return () => {
      live = false;
      off?.();
      if (started) api.screenStop(device.node, paneId).catch(() => undefined);
    };
  }, [api, device.node, device.name, paneId, online, t]);
  const send = () => {
    const value = line;
    if (value === '') return;
    setLine('');
    api
      .request(device.node, 'POST', `/panes/${encodeURIComponent(paneId)}/input`, { text: value, append_newline: true })
      .then((res) => res.status >= 300 && setError(requestError(device.name, res)))
      .catch((e: unknown) => setError(errorSentence(e)));
  };
  return (
    <>
      {error && <p className="dev-remote-note" role="alert">{error}</p>}
      {text === null && !error ? <p className="dev-remote-note">{t('devices.remote.loading', { name: device.name })}</p> : <pre className="dev-remote-screen" data-testid="remote-screen">{text}</pre>}
      {canType && (
        <form
          className="dev-remote-send"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <input type="text" value={line} placeholder={t('devices.remote.placeholder', { name: device.name })} onChange={(e) => setLine(e.target.value)} data-testid="remote-input" />
          <button type="submit" className="dev-btn" disabled={line === ''}>
            {t('devices.remote.send')}
          </button>
        </form>
      )}
    </>
  );
}
