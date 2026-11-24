// The one place a far pane's host and cockpit are made for the normal pane screen: the PC link client of that PC, what it lets this PC do
// (its own `GET /pclink/me`, read again every few seconds), the host over them (`farHost`) and the cockpit the screen reads (`farCockpit`).
// A component calls this and renders `PaneView` inside `HostProvider`; it never sees the PC link.
import { useContext, useMemo, useRef } from 'react';
import { FarNeedsContext } from '../../hooks/useNeedsYou';
import type { CockpitApi } from '../../hooks/useCockpit';
import { devicesApi, type Device, type DevicesApi } from '../devices';
import { useFarLevel } from '../runtime/farLevel';
import { makeRemoteClient } from '../runtime/remote';
import { atLeast, type PcLinkClient } from '../runtime/pclink';
import { farCockpit, type FarRow } from './farCockpit';
import { farHost } from './far';
import { t } from '../../i18n';
import { ALL_CAPS, WATCH_CAPS, type Caps, type Host } from './host';

/** What a level lets this person do there (the far PC still enforces it; this only decides what is drawn disabled). */
export const capsOf = (level: Parameters<typeof atLeast>[0]): Caps => {
  const full = atLeast(level, 'full');
  const answer = atLeast(level, 'answer');
  return full ? ALL_CAPS : { ...WATCH_CAPS, message: answer, answer };
};

/** While the far PC is off, the message box says so (its work keeps running there) instead of the watch-only reason; it is back by itself when the PC is. */
export const whenOffline = (host: Host, device: Pick<Device, 'state' | 'name' | 'quiet'>, levelKnown = true): Host =>
  // A level never read (the PC is off since this window opened) is not "needs Full": every control says the PC is off.
  device.state === 'online' ? host : { ...host, denied: (cap) => (cap === 'message' || cap === 'answer' || !levelKnown ? t(device.quiet ? 'devices.remote.quiet' : 'devices.remote.offline', { name: device.name }) : (host.denied?.(cap) ?? null)) };

export function useFarPane({ device, rows, c, openRow, api = devicesApi, ended = false }: { device: Device; rows: readonly FarRow[]; c: CockpitApi; openRow: (key: string) => void; api?: DevicesApi; ended?: boolean }): { host: Host; cockpit: CockpitApi; client: PcLinkClient } {
  const client = useMemo(() => makeRemoteClient(device.node, api), [device.node, api]);
  const far = useFarLevel(client, device.state === 'online');
  // The last level the far PC gave stays while it is away: what was allowed before is drawn the same (it still says the PC is off).
  const lastLevel = useRef(far.level);
  if (far.level) lastLevel.current = far.level;
  const caps = useMemo(() => capsOf(far.level ?? lastLevel.current), [far.level]); // eslint-disable-line react-hooks/exhaustive-deps
  const live = useMemo(() => farHost(client, api, { name: device.name, caps }), [client, api, device.name, caps]);
  const known = !!(far.level ?? lastLevel.current);
  // The link to that PC: the same while only its level changes (the chat's readers are opened once); a new one when it goes off or comes back.
  const online = device.state === 'online';
  const link = useMemo(() => ({}), [client, api, device.name, online, ended]); // eslint-disable-line react-hooks/exhaustive-deps
  const host = useMemo(() => {
    const away = { ...whenOffline(live, { state: device.state, name: device.name, quiet: device.quiet }, known), link };
    // An ended chat: every control says so, and the feed is not opened (the last transcript this PC held is what is drawn).
    return ended ? { ...away, ended: true, denied: () => t('r15far.endedReason') } : away;
  }, [live, device.state, device.name, device.quiet, known, ended, link]);
  const cockpit = farCockpit(c, client, device.name, rows, live.notYet ?? '', openRow, useContext(FarNeedsContext));
  return { host, cockpit, client };
}
