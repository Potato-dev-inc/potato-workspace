import type { PaneInfo } from '@potato-workspace/shared';
import { pcModeOf, pcNameOf, type PcMode, type PcSession } from '../../lib/runtime/pclink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { devicesApi, remoteId, type Device, type DevicesApi, type DevicesView } from '../../lib/devices';
import { makeRemoteClient, subscribeRemote } from '../../lib/runtime/remote';
import { pollWithBackoff } from '../../lib/runtime/pollWithBackoff';
import { useDevices } from './useDevices';

/** How often each online device's pane list is read again when no event came. */
export const GROUP_POLL_MS = 15_000;

/** One pane or chat of another device, as this PC lists it. Texts come from the other device: show them as text only. */
export interface RemoteRow {
  /** `dev:<node>:<pane id>`: nothing local can look like it. */
  key: string;
  node: string;
  paneId: string;
  title: string;
  agent: string;
  status: PaneInfo['status'];
  /** The folder's name on that PC (never its path). */
  cwd: string;
  /** The folder's opaque id on that PC: what groups the rows. */
  project: string;
  /** A chat session (no terminal behind it). */
  chat: boolean;
  /** The pane that started this one (a minion or a helper sits under it, like on this PC), if the far PC says. */
  parent?: string;
  /** What the far PC says about the chat (a newer far PC only): its git branch name, model name and permission mode. */
  branch?: string;
  model?: string;
  mode?: PcMode;
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

export function rowOf(node: string, p: PcSession): RemoteRow {
  // A device only serves its own local sessions: an id that already names a device is never listed.
  return {
    key: remoteId(node, p.id),
    node,
    paneId: p.id,
    title: clip(p.title, 80) || clip(p.agent, 40),
    agent: clip(p.agent, 40),
    status: p.status as PaneInfo['status'],
    cwd: clip(p.folder, 120),
    project: clip(p.project, 40),
    chat: p.chat === true,
    ...(typeof p.parent === 'string' && p.parent ? { parent: p.parent.slice(0, 200) } : {}),
    ...(pcNameOf(p.branch) ? { branch: pcNameOf(p.branch) } : {}),
    ...(pcNameOf(p.model) ? { model: pcNameOf(p.model) } : {}),
    ...(pcModeOf(p.mode) ? { mode: pcModeOf(p.mode) } : {}),
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
      // A failure throws to the poller (it backs off); the state says the link dropped and the last rows stay.
      const sessions = await makeRemoteClient(node, api).sessions();
      if (!alive.current) return;
      setRows((prev) => ({ ...prev, [node]: sessions.filter((p) => typeof p?.id === 'string' && !p.id.startsWith('dev:')).map((p) => rowOf(node, p)) }));
    },
    [api],
  );

  useEffect(() => {
    if (!enabled) return;
    const nodes = onlineKey ? onlineKey.split('|') : [];
    const stops: (() => void)[] = [];
    let live = true;
    for (const node of nodes) {
      subscribeRemote(node, api, (e) => {
        if (e.type === 'sessions') void read(node).catch(() => undefined);
        else if (e.type === 'session-status') setRows((prev) => ({ ...prev, [node]: (prev[node] ?? []).map((r) => (r.paneId === e.id ? { ...r, status: e.status as PaneInfo['status'] } : r)) }));
      })
        .then((stop) => (live ? stops.push(stop) : stop()))
        .catch(() => undefined);
    }
    const polls = nodes.map((node) => pollWithBackoff({ node, route: 'sessions', normalMs: GROUP_POLL_MS, run: () => read(node) }));
    return () => {
      live = false;
      polls.forEach((stop) => stop());
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
