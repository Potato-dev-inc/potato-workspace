import type { PaneInfo } from '@potato-workspace/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { devicesApi, remoteId, type Device, type DevicesApi, type DevicesView } from '../../lib/devices';
import { makeRemoteClient, subscribeRemote } from '../../lib/runtime/remote';
import { useDevices } from './useDevices';

/** How often each online device's pane list is read again when no event came. */
export const GROUP_POLL_MS = 5000;

/** One pane or chat of another device, as this PC lists it. Texts come from the other device: show them as text only. */
export interface RemoteRow {
  /** `dev:<node>:<pane id>`: nothing local can look like it. */
  key: string;
  node: string;
  paneId: string;
  title: string;
  agent: string;
  status: PaneInfo['status'];
  cwd: string;
  /** A chat session (no terminal behind it). */
  chat: boolean;
}

export interface DeviceGroup {
  device: Device;
  rows: RemoteRow[];
}

export interface DeviceGroups {
  view: DevicesView | null;
  /** The Labs switch, as the backend reports it. */
  enabled: boolean;
  groups: DeviceGroup[];
  refresh: () => void;
}

const clip = (s: unknown, max: number): string => (typeof s === 'string' ? s.slice(0, max) : '');

export function rowOf(node: string, p: PaneInfo): RemoteRow {
  // A device only serves its own local panes: an id that already names a device is never listed.
  return {
    key: remoteId(node, p.id),
    node,
    paneId: p.id,
    title: clip(p.title, 80) || clip(p.agent_type, 40),
    agent: clip(p.agent_type, 40),
    status: p.status,
    cwd: clip(p.cwd, 300),
    chat: p.lane === 'acp',
  };
}

/**
 * The sidebar groups: one per paired device that has something to show. An online device is read through the link and
 * kept current by its event stream; one that goes offline keeps the rows it last had, greyed (nothing lived on this
 * side, so nothing is lost). A device that does not let this PC in has a group with only its header.
 */
export function useDeviceGroups(api: DevicesApi = devicesApi): DeviceGroups {
  const { view, enabled, refresh } = useDevices(api);
  const [rows, setRows] = useState<Record<string, RemoteRow[]>>({});
  const online = useMemo(() => (view?.devices ?? []).filter((d) => d.state === 'online').map((d) => d.node), [view]);
  const onlineKey = online.join('|');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const read = useCallback(
    async (node: string) => {
      try {
        const panes = await makeRemoteClient(node, api).listPanes();
        if (!alive.current) return;
        setRows((prev) => ({ ...prev, [node]: panes.filter((p) => typeof p?.id === 'string' && !p.id.startsWith('dev:')).map((p) => rowOf(node, p)) }));
      } catch {
        /* the link dropped or the device refused: the state says so, the last rows stay */
      }
    },
    [api],
  );

  useEffect(() => {
    if (!enabled) return;
    const nodes = onlineKey ? onlineKey.split('|') : [];
    const stops: (() => void)[] = [];
    let live = true;
    for (const node of nodes) {
      void read(node);
      subscribeRemote(node, api, (e) => {
        if (e.type === 'panes') void read(node);
        else if (e.type === 'pane-status') setRows((prev) => ({ ...prev, [node]: (prev[node] ?? []).map((r) => (r.paneId === e.pane_id ? { ...r, status: e.status } : r)) }));
      })
        .then((stop) => (live ? stops.push(stop) : stop()))
        .catch(() => undefined);
    }
    const poll = window.setInterval(() => nodes.forEach((n) => void read(n)), GROUP_POLL_MS);
    return () => {
      live = false;
      window.clearInterval(poll);
      stops.forEach((s) => s());
    };
  }, [enabled, onlineKey, api, read]);

  const groups = useMemo<DeviceGroup[]>(() => {
    if (!enabled || !view) return [];
    return view.devices
      .map((device) => ({ device, rows: rows[device.node] ?? [] }))
      .filter((g) => g.rows.length > 0 || g.device.state === 'not_allowed' || g.device.needs_person.length > 0);
  }, [enabled, view, rows]);

  return { view, enabled, groups, refresh };
}
