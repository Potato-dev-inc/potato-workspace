// The hosts of the other PCs that are online, for the screens that list across places (closed chats, chat search). Each is the same
// `farHost` a project of that PC gets; only its reads are used here. The list changes only when a PC comes or goes.
import { useMemo } from 'react';
import { devicesApi, type Device, type DevicesApi } from '../devices';
import { makeRemoteClient } from '../runtime/remote';
import { farHost } from './far';
import type { Host } from './host';

export function useFarHosts(devices: readonly Pick<Device, 'node' | 'name' | 'state'>[], api: DevicesApi = devicesApi): Host[] {
  const key = devices.filter((d) => d.state === 'online').map((d) => `${d.node}\u0000${d.name}`).join('\n');
  return useMemo(
    () =>
      key
        ? key.split('\n').map((entry) => {
            const [node, name] = entry.split('\u0000');
            return farHost(makeRemoteClient(node, api), api, { name });
          })
        : [],
    [key, api],
  );
}
