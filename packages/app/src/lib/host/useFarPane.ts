// The one place a far pane's host and cockpit are made for the normal pane screen: the PC link client of that PC, what it lets this PC do
// (its own `GET /pclink/me`, read again every few seconds), the host over them (`farHost`) and the cockpit the screen reads (`farCockpit`).
// A component calls this and renders `PaneView` inside `HostProvider`; it never sees the PC link.
import { useMemo } from 'react';
import type { CockpitApi } from '../../hooks/useCockpit';
import { devicesApi, type Device, type DevicesApi } from '../devices';
import { useFarLevel } from '../runtime/farLevel';
import { makeRemoteClient } from '../runtime/remote';
import { atLeast } from '../runtime/pclink';
import { farCockpit, type FarRow } from './farCockpit';
import { farHost } from './far';
import { ALL_CAPS, WATCH_CAPS, type Caps, type Host } from './host';

/** What a level lets this person do there (the far PC still enforces it; this only decides what is drawn disabled). */
export const capsOf = (level: Parameters<typeof atLeast>[0]): Caps => {
  const full = atLeast(level, 'full');
  const answer = atLeast(level, 'answer');
  return full ? ALL_CAPS : { ...WATCH_CAPS, message: answer, answer };
};

export function useFarPane({ device, rows, c, openRow, api = devicesApi }: { device: Device; rows: readonly FarRow[]; c: CockpitApi; openRow: (key: string) => void; api?: DevicesApi }): { host: Host; cockpit: CockpitApi } {
  const client = useMemo(() => makeRemoteClient(device.node, api), [device.node, api]);
  const far = useFarLevel(client, device.state === 'online');
  const caps = useMemo(() => capsOf(far.level), [far.level]);
  const host = useMemo(() => farHost(client, api, { name: device.name, caps }), [client, api, device.name, caps]);
  const cockpit = farCockpit(c, client, device.name, rows, host.notYet ?? '', openRow);
  return { host, cockpit };
}
