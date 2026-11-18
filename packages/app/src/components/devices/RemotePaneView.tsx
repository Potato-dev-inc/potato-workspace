// A chat or a terminal that runs on another device, opened from the sidebar. The chat is the normal chat screen (the same
// conversation and message box as a chat on this PC), fed by the far PC's `/pclink/` routes; which PC it is is said by the chip at the top of the sidebar; the terminal is a simple live screen (the far side pushes the text the
// moment it changes), with a line to type into when the device lets this PC work on it (Full). The far device enforces its rights: this view only hides buttons.
// A device that goes away leaves the last text on screen and says so (nothing lived on this side, so nothing is lost).
import { useEffect, useMemo, useState } from 'react';
import { AgentLogo } from '../common/AgentLogo';
import { useT } from '../../i18n';
import { clipText, devicesApi, deviceNotices, requestError, type Device, type DevicesApi } from '../../lib/devices';
import { errorSentence } from '../../lib/sayError';
import { makeRemoteClient } from '../../lib/runtime/remote';
import { useFarLevel } from '../../lib/runtime/farLevel';
import { atLeast, PcLinkError, type PcLinkClient } from '../../lib/runtime/pclink';
import { RemoteChat } from './RemoteChat';
import { lastPart } from '../../lib/deviceFiles';
import { DeviceNotices } from './DeviceNotices';
import { FilesView } from './FilesView';
import { GetItCard } from './GetItCard';
import type { RemoteRow } from './useDeviceGroups';
import '../../styles/devices.css';

export function RemotePaneView({ device, row, api = devicesApi, onRetry }: { device: Device; row: Pick<RemoteRow, 'paneId' | 'chat' | 'title'> & Partial<Pick<RemoteRow, 'agent' | 'cwd' | 'status' | 'branch' | 'model' | 'mode'>>; api?: DevicesApi; onRetry?: () => void }) {
  const t = useT();
  const client = useMemo(() => makeRemoteClient(device.node, api), [device.node, api]);
  // What the far PC lets this PC do is the far PC's to say: this side only hides what it would refuse.
  const far = useFarLevel(client, device.state === 'online');
  const canSend = device.state === 'online' && atLeast(far.level, 'answer');
  const canTerminal = device.state === 'online' && atLeast(far.level, 'full');
  const [showFiles, setShowFiles] = useState(false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const folderName = lastPart(row.cwd ?? '');
  return (
    <section className="dev-remote" data-testid="remote-pane" aria-label={device.name}>
      {!showFiles && (
        // The normal pane header: the agent's name, a small tag with the PC it runs on, the project. The chat's own header controls
        // (view switch) are drawn into the empty end of it, as in a chat on this PC.
        <div className="dev-remote-bar" data-testid="remote-head">
          {row.agent && <AgentLogo id={row.agent} name={row.agent} size={14} decorative />}
          <span className="dev-remote-name" data-testid="remote-name">
            {row.title || row.agent || ''}
          </span>
          <span className="dev-remote-tag" data-testid="remote-tag">
            {clipText(device.name, 40)}
          </span>
          {folderName && (
            <button type="button" className="dev-btn is-plain dev-remote-folder" onClick={() => setShowFiles(true)} data-testid="open-remote-folder" title={t('devices.files.openFolder', { name: clipText(device.name, 40) })} aria-label={t('devices.files.openFolder', { name: clipText(device.name, 40) })}>
              {folderName}
            </button>
          )}
          {row.branch && (
            <span className="dev-remote-branch" data-testid="remote-branch" title={row.branch}>
              {clipText(row.branch, 40)}
            </span>
          )}
          <span className="dev-remote-slot" ref={setSlot} />
        </div>
      )}
      <DeviceNotices notices={deviceNotices(device, row.agent ? [row.agent] : undefined)} onRetry={onRetry} />
      {device.state === 'offline' && <p className="dev-remote-note">{t('devices.remote.offline', { name: device.name })}</p>}
      <div className="dev-remote-body">
        {showFiles ? (
          <FilesView device={device} api={api} startAt={{ folderName }} onClose={() => setShowFiles(false)} />
        ) : row.chat ? (
          slot && <RemoteChat key={row.paneId} headerSlot={{ el: slot, compact: true }} node={device.node} client={client} paneId={row.paneId} canWatch={device.state !== 'not_allowed'} canType={canSend} running={row.status === 'running'} online={device.state === 'online'} name={device.name} canFull={canTerminal} meta={{ agent: row.agent, branch: row.branch, model: row.model, mode: row.mode }} />
        ) : (
          <RemoteScreen device={device} paneId={row.paneId} api={api} client={client} canType={canTerminal} />
        )}
      </div>
      {row.chat && !showFiles && <GetItCard device={device} paneId={row.paneId} cwd={row.cwd} api={api} />}
    </section>
  );
}

/** The far PC's sentence for a failed call: its own words when it sent some. */
function said(name: string, e: unknown): string {
  return e instanceof PcLinkError ? requestError(name, { status: e.status, body: e.body }) : errorSentence(e);
}

function RemoteScreen({ device, paneId, api, client, canType }: { device: Device; paneId: string; api: DevicesApi; client: PcLinkClient; canType: boolean }) {
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
      client
        .screen(paneId)
        .then((content) => {
          if (!live) return;
          setError(null);
          setText(content);
        })
        .catch((e: unknown) => {
          if (!live) return;
          setError(e instanceof PcLinkError && e.status === 404 ? t('devices.remote.gone', { name: device.name }) : said(device.name, e));
        });
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
  }, [api, client, device.node, device.name, paneId, online, t]);
  const send = () => {
    const value = line;
    if (value === '') return;
    setLine('');
    client.input(paneId, value).catch((e: unknown) => setError(said(device.name, e)));
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
