// A session of another PC, opened from the Projects list. A chat is the NORMAL pane screen (`PaneView`), drawn inside the host of that PC:
// the same header, view menu, settings chips and message box as a chat on this PC, its calls going over the PC link. Nothing in it knows
// which PC it is on except the small badge and the controls the far PC cannot answer yet, which are drawn disabled with one reason.
// A far terminal keeps its simple screen until Phase 2 (`RemoteTerminal`).
import type { ComponentProps } from 'react';
import type { CockpitApi } from '../../hooks/useCockpit';
import { clipText, devicesApi, type Device, type DevicesApi } from '../../lib/devices';
import { HostProvider } from '../../lib/host/context';
import { farHandoffDeps } from '../../lib/host/farHandoff';
import { awayStatus } from '../../lib/runtime/farBeat';
import { useFarPane } from '../../lib/host/useFarPane';
import { PaneView } from '../cockpit/PaneView';
import { useT } from '../../i18n';
import { RemoteTerminal } from './RemoteTerminal';
import type { RemoteRow } from './useDeviceGroups';

type PaneViewExtras = Pick<ComponentProps<typeof PaneView>, 'onWhatBroke' | 'onSeeDay' | 'handoff'>;

function FarChat({ device, row, rows, c, openRow, extras, api, ended, onClosed }: { api: DevicesApi; device: Device; row: RemoteRow; rows: readonly RemoteRow[]; c: CockpitApi; openRow: (key: string) => void; extras: PaneViewExtras; ended: boolean; onClosed?: () => void }) {
  // While the far PC reconnects its list can be empty: the open chat must still be a pane of the screen (else it waits for ever).
  const shownRow: RemoteRow = ended ? { ...row, ended: true, status: 'exited' as RemoteRow['status'] } : device.quiet && (row.status === 'running' || row.status === 'waiting_input') ? { ...row, status: awayStatus(row.status, true) as RemoteRow['status'] } : device.state !== 'online' && row.status === 'running' ? { ...row, status: 'exited' as RemoteRow['status'] } : row;
  const all = rows.some((r) => r.key === row.key) ? rows.map((r) => (r.key === row.key ? shownRow : r)) : [...rows, shownRow];
  const { host, cockpit: farCk, client } = useFarPane({ device, rows: all, c, openRow, api, ended });
  // Close on an ended chat only forgets it here: the far PC no longer has it.
  const cockpit = ended ? { ...farCk, closePane: async () => onClosed?.() } : farCk;
  const t = useT();
  // Hand off walks the same steps as on this PC, every call going to that PC's host (its agent writes the note, its agent starts).
  const handoff = extras.handoff && {
    ...extras.handoff,
    allowed: () => true,
    start: (id: string) => extras.handoff?.start(id, farHandoffDeps(host, client, rows, openRow, (key) => cockpit.names.get(key))),
  };
  // The link is down (or the chat ended): one plain line says so, whatever the chat shows below (its last words stay).
  const note = ended ? t('devices.remote.goneChat', { name: clipText(device.name, 40) }) : device.state !== 'online' && device.state !== 'not_allowed' ? t(device.quiet ? 'devices.remote.quiet' : 'devices.remote.offline', { name: device.name }) : null;
  // The banner says it once: the message box stays off but does not say the same words again under itself ('' switches it off with no line).
  const once: typeof host = note && !ended ? { ...host, denied: (cap) => { const why = host.denied?.(cap) ?? null; return cap === 'message' && why === note ? '' : why; } } : host;
  return (
    <HostProvider host={once}>
      <div className="dev-farchat">
        {note && (
          <div className="dev-farchat-note" role="status" data-testid={ended ? 'far-gone' : 'remote-offline'}>
            <span>{note}</span>
            {ended && (
              <button type="button" className="dev-btn is-plain" data-testid="far-gone-close" onClick={onClosed}>
                {t('sidebar.close')}
              </button>
            )}
          </div>
        )}
        {/* "Hand off" is drawn for this chat as for any (its command is the far PC's to answer, the screen disables it until it can). */}
        <PaneView c={cockpit} paneId={row.key} {...extras} handoff={handoff} />
      </div>
    </HostProvider>
  );
}

export function FarPane({ device, row, rows, c, openRow, onRetry, onClosed, extras = {}, api = devicesApi, ended = false }: { api?: DevicesApi; device: Device; row: RemoteRow; /** Every session of that PC (the helpers of this chat are among them). */ rows: readonly RemoteRow[]; c: CockpitApi; openRow: (key: string) => void; onRetry?: () => void; onClosed?: () => void; extras?: PaneViewExtras; /** The chat ended while its PC was off: its last look and transcript, and Close. */ ended?: boolean }) {
  return row.chat ? <FarChat device={device} row={row} rows={rows} c={c} openRow={openRow} extras={extras} api={api} ended={ended || row.ended === true} onClosed={onClosed} /> : <RemoteTerminal device={device} row={row} api={api} onRetry={onRetry} handoff={extras.handoff} rows={rows} openRow={openRow} onClosed={onClosed} />;
}
