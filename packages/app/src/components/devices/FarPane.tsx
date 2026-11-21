// A session of another PC, opened from the Projects list. A chat is the NORMAL pane screen (`PaneView`), drawn inside the host of that PC:
// the same header, view menu, settings chips and message box as a chat on this PC, its calls going over the PC link. Nothing in it knows
// which PC it is on except the small badge and the controls the far PC cannot answer yet, which are drawn disabled with one reason.
// A far terminal keeps its simple screen until Phase 2 (`RemoteTerminal`).
import type { ComponentProps } from 'react';
import type { CockpitApi } from '../../hooks/useCockpit';
import { devicesApi, type Device, type DevicesApi } from '../../lib/devices';
import { HostProvider } from '../../lib/host/context';
import { useFarPane } from '../../lib/host/useFarPane';
import { PaneView } from '../cockpit/PaneView';
import { RemoteTerminal } from './RemoteTerminal';
import type { RemoteRow } from './useDeviceGroups';

type PaneViewExtras = Pick<ComponentProps<typeof PaneView>, 'onWhatBroke' | 'onSeeDay' | 'handoff'>;

function FarChat({ device, row, rows, c, openRow, extras, api }: { api: DevicesApi; device: Device; row: RemoteRow; rows: readonly RemoteRow[]; c: CockpitApi; openRow: (key: string) => void; extras: PaneViewExtras }) {
  const { host, cockpit } = useFarPane({ device, rows, c, openRow, api });
  return (
    <HostProvider host={host}>
      {/* "Hand off" is drawn for this chat as for any (its command is the far PC's to answer, the screen disables it until it can). */}
      <PaneView c={cockpit} paneId={row.key} {...extras} handoff={extras.handoff && { ...extras.handoff, allowed: () => true }} />
    </HostProvider>
  );
}

export function FarPane({ device, row, rows, c, openRow, onRetry, extras = {}, api = devicesApi }: { api?: DevicesApi; device: Device; row: RemoteRow; /** Every session of that PC (the helpers of this chat are among them). */ rows: readonly RemoteRow[]; c: CockpitApi; openRow: (key: string) => void; onRetry?: () => void; extras?: PaneViewExtras }) {
  return row.chat ? <FarChat device={device} row={row} rows={rows} c={c} openRow={openRow} extras={extras} api={api} /> : <RemoteTerminal device={device} row={row} api={api} onRetry={onRetry} />;
}
