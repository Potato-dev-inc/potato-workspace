// A terminal that runs on another device, opened from the sidebar: the normal terminal (`FarTerminal`, the far PC's pane stream drawn by
// `TerminalViewport`) and the folder's files. KEPT until Phase 5 (files in the normal file tree); a far CHAT is the normal pane screen (`FarPane`).
// The far device enforces its rights: this view only hides buttons.
import { useEffect, useMemo, useRef, useState } from 'react';
import { subscribePaneActions } from '../../lib/pane-actions';
import { AgentLogo } from '../common/AgentLogo';
import { useT } from '../../i18n';
import { clipText, devicesApi, deviceNotices, type Device, type DevicesApi } from '../../lib/devices';
import { makeRemoteClient } from '../../lib/runtime/remote';
import { useFarLevel } from '../../lib/runtime/farLevel';
import { atLeast } from '../../lib/runtime/pclink';
import type { HandoffControl } from '../../hooks/useHandoff';
import { farHandoffDeps } from '../../lib/host/farHandoff';
import { FarTerminal } from './FarTerminal';
import { farHost } from '../../lib/host/far';
import { ALL_CAPS, WATCH_CAPS } from '../../lib/host/host';
import { lastPart } from '../../lib/deviceFiles';
import { handoffLabel } from '../../lib/handoff';
import { idOfKey, placeKey } from '../../lib/host/placeKey';
import { LentChip } from '../lend/LentChip';
import { DeviceNotices } from './DeviceNotices';
import { FilesView } from './FilesView';
import type { RemoteRow } from './useDeviceGroups';
import '../../styles/devices.css';

export function RemoteTerminal({ device, row, api = devicesApi, onRetry, handoff, rows, openRow, onClosed }: { device: Device; row: Pick<RemoteRow, 'paneId' | 'chat' | 'title'> & Partial<Pick<RemoteRow, 'agent' | 'cwd' | 'status' | 'branch' | 'key' | 'project'>>; api?: DevicesApi; onRetry?: () => void; /** Hand off the agent in this terminal: the same walk as for a chat, on that PC. */ handoff?: HandoffControl; rows?: readonly RemoteRow[]; openRow?: (key: string) => void; /** The terminal was closed on the far PC: leave its screen. */ onClosed?: () => void }) {
  const t = useT();
  const client = useMemo(() => makeRemoteClient(device.node, api), [device.node, api]);
  // What the far PC lets this PC do is the far PC's to say: this side only hides what it would refuse.
  const far = useFarLevel(client, device.state === 'online');
  const canTerminal = device.state === 'online' && atLeast(far.level, 'full');
  const host = useMemo(() => farHost(client, api, { name: device.name, caps: canTerminal ? ALL_CAPS : WATCH_CAPS }), [client, api, device.name, canTerminal]);
  const [showFiles, setShowFiles] = useState(false);
  const [closing, setClosing] = useState(false);
  const [wantClose, setWantClose] = useState(false);
  // Close ends the terminal on the far PC (its own `kill_pane_cmd`); the sidebar row menu asks the same through the pane actions.
  const close = async () => {
    if (device.state === 'online' && !canTerminal) return setWantClose(true); // asked from the sidebar before the far PC said Full: it runs the moment it does
    if (closing) return;
    setClosing(true);
    try {
      if (device.state === 'online') await host.invoke<void>('kill_pane_cmd', { paneId: idOfKey(device.node, row.paneId) });
    } catch {
      // The far PC lost the pane (it restarted) or does not answer: the screen still goes, and a pane that is still there comes back in the list.
    }
    setClosing(false);
    onClosed?.();
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (wantClose && canTerminal) {
      setWantClose(false);
      void closeRef.current();
    }
  }, [wantClose, canTerminal]);
  useEffect(() => (row.key ? subscribePaneActions(row.key, (action) => action === 'close' && void closeRef.current()) : undefined), [row.key]);
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
          {handoff && row.key && row.agent && rows && openRow && (
            <button
              type="button"
              className="dev-btn is-plain"
              data-testid="pane-handoff"
              disabled={handoff.busy || !canTerminal || host.can?.('handoff_quick_prepare') === false}
              title={host.can?.('handoff_quick_prepare') === false ? host.notYet : handoff.mode === 'file' ? t('pane.handoffFileTip') : t('pane.handoffAgentTip')}
              onClick={() => handoff.start(row.key!, farHandoffDeps(host, client, rows, openRow, () => undefined))}
            >
              {handoff.busy ? t('pane.handingOff') : handoff.mode === 'file' ? handoffLabel(handoff.mode) : t('pane.handOff')}
            </button>
          )}
          {row.branch && (
            <span className="dev-remote-branch" data-testid="remote-branch" title={row.branch}>
              {clipText(row.branch, 40)}
            </span>
          )}
          <button type="button" className="dev-btn is-plain dev-remote-close" data-testid="remote-close" disabled={closing} title={t('devices.remote.closeTip', { name: clipText(device.name, 40) })} onClick={() => void close()}>
            {t('sidebar.close')}
          </button>
        </div>
      )}
      <DeviceNotices notices={deviceNotices(device, row.agent ? [row.agent] : undefined)} onRetry={onRetry} />
      {device.state === 'offline' && (
        <p className="dev-remote-note" role="status" data-testid="remote-offline">
          {t('devices.remote.offline', { name: device.name })}
        </p>
      )}
      <div className="dev-remote-body">
        {showFiles ? (
          <FilesView device={device} api={api} startAt={{ folderName }} onClose={() => setShowFiles(false)} />
        ) : (
          <FarTerminal key={`${row.paneId}:${device.state === 'online' ? 'on' : 'off'}`} name={device.name} paneId={row.paneId} row={{ agent: row.agent ?? '', status: row.status ?? 'idle', cwd: row.cwd ?? '' }} host={host} />
        )}
      </div>
    </section>
  );
}
