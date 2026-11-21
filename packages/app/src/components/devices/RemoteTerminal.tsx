// A terminal that runs on another device, opened from the sidebar: the normal terminal (`FarTerminal`, the far PC's pane stream drawn by
// `TerminalViewport`) and the folder's files. KEPT until Phase 5 (files in the normal file tree); a far CHAT is the normal pane screen (`FarPane`).
// The far device enforces its rights: this view only hides buttons.
import { useMemo, useState } from 'react';
import { AgentLogo } from '../common/AgentLogo';
import { useT } from '../../i18n';
import { clipText, devicesApi, deviceNotices, type Device, type DevicesApi } from '../../lib/devices';
import { makeRemoteClient } from '../../lib/runtime/remote';
import { useFarLevel } from '../../lib/runtime/farLevel';
import { atLeast } from '../../lib/runtime/pclink';
import { FarTerminal } from './FarTerminal';
import { farHost } from '../../lib/host/far';
import { ALL_CAPS, WATCH_CAPS } from '../../lib/host/host';
import { lastPart } from '../../lib/deviceFiles';
import { DeviceNotices } from './DeviceNotices';
import { FilesView } from './FilesView';
import type { RemoteRow } from './useDeviceGroups';
import '../../styles/devices.css';

export function RemoteTerminal({ device, row, api = devicesApi, onRetry }: { device: Device; row: Pick<RemoteRow, 'paneId' | 'chat' | 'title'> & Partial<Pick<RemoteRow, 'agent' | 'cwd' | 'status' | 'branch'>>; api?: DevicesApi; onRetry?: () => void }) {
  const t = useT();
  const client = useMemo(() => makeRemoteClient(device.node, api), [device.node, api]);
  // What the far PC lets this PC do is the far PC's to say: this side only hides what it would refuse.
  const far = useFarLevel(client, device.state === 'online');
  const canTerminal = device.state === 'online' && atLeast(far.level, 'full');
  const host = useMemo(() => farHost(client, api, { name: device.name, caps: canTerminal ? ALL_CAPS : WATCH_CAPS }), [client, api, device.name, canTerminal]);
  const [showFiles, setShowFiles] = useState(false);
  const folderName = lastPart(row.cwd ?? '');
  return (
    <section className="dev-remote" data-testid="remote-pane" aria-label={device.name}>
      {!showFiles && (
        // The agent's name, a small tag with the PC it runs on, the project.
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
        </div>
      )}
      <DeviceNotices notices={deviceNotices(device, row.agent ? [row.agent] : undefined)} onRetry={onRetry} />
      {device.state === 'offline' && <p className="dev-remote-note">{t('devices.remote.offline', { name: device.name })}</p>}
      <div className="dev-remote-body">
        {showFiles ? (
          <FilesView device={device} api={api} startAt={{ folderName }} onClose={() => setShowFiles(false)} />
        ) : (
          <FarTerminal key={row.paneId} name={device.name} paneId={row.paneId} row={{ agent: row.agent ?? '', status: row.status ?? 'idle', cwd: row.cwd ?? '' }} host={host} />
        )}
      </div>
    </section>
  );
}
