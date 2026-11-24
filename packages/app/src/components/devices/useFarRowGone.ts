// A far chat or terminal that was in its PC's list and, once the PC answered again, is not: it ended while the PC was off (the app there
// restarted). Said once the list was read AFTER the PC came back, never while it is only away (the last known row stays drawn then).
import { useRef } from 'react';
import type { DeviceGroups, RemoteRow } from './useDeviceGroups';

export function farRowGone(s: { online: boolean; listed: boolean; seen: boolean; present: boolean }): boolean {
  return s.online && s.listed && s.seen && !s.present;
}

export function useFarRowGone(groups: DeviceGroups, row: RemoteRow | null): boolean {
  const seen = useRef(new Set<string>());
  if (!row) return false;
  const present = !!groups.groups.find((g) => g.device.node === row.node)?.rows.some((r) => r.key === row.key);
  if (present) seen.current.add(row.key);
  const online = groups.view?.devices.find((d) => d.node === row.node)?.state === 'online';
  return farRowGone({ online, listed: groups.listed.has(row.node), seen: seen.current.has(row.key), present });
}
