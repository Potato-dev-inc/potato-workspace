import type { PaneInfo } from '@potato-workspace/shared';
import { pcModeOf, pcNameOf, type PcMode, type PcSession } from '../../lib/runtime/pclink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { devicesApi, remoteId, type Device, type DevicesApi, type DevicesView } from '../../lib/devices';
import { makeRemoteClient, subscribeRemote } from '../../lib/runtime/remote';
import { pollWithBackoff } from '../../lib/runtime/pollWithBackoff';
import { deviceLocation, type ProjectLocation } from '../../lib/projectLocation';
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
  /** `minion` | `spin_off`, as this PC's own panes carry it. */
  startedAs?: 'minion' | 'spin_off';
  /** A standby's own chat: not an agent row (hidden here as on its own PC). */
  standby?: boolean;
  /** It works on a separate copy of its project. */
  copy?: boolean;
  /** The workflow mark the far PC gives this chat (its own, not a mark of this PC's browser storage). */
  workflow?: PcSession['workflow'];
  /** What the far PC says about the chat (a newer far PC only): its git branch name, model name and permission mode. */
  branch?: string;
  model?: string;
  mode?: PcMode;
  /** Where this row lives: that device. */
  location: ProjectLocation;
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

/** The session that started this one: `helper_of` (a newer far PC), else `parent`. */
const parentOf = (p: PcSession): string => clip(p.helper_of ?? p.parent, 200);

export function rowOf(node: string, p: PcSession, name = ''): RemoteRow {
  // A device only serves its own local sessions: an id that already names a device is never listed.
  return {
    key: remoteId(node, p.id),
    node,
    paneId: p.id,
    // No title: the row is called by its agent's name, numbered like the rows of that PC (`paneNames`), never by the raw agent id.
    title: clip(p.title, 80),
    agent: clip(p.agent, 40),
    status: p.status as PaneInfo['status'],
    cwd: clip(p.folder, 120),
    project: clip(p.project, 40),
    chat: p.chat === true || p.lane === 'acp',
    location: deviceLocation(node, name),
    ...(parentOf(p) ? { parent: parentOf(p) } : {}),
    ...(p.started_as === 'minion' || p.started_as === 'spin_off' ? { startedAs: p.started_as } : {}),
    ...(p.standby === true ? { standby: true } : {}),
    ...(p.copy === true ? { copy: true } : {}),
    ...(p.workflow && typeof p.workflow.slug === 'string' ? { workflow: { slug: clip(p.workflow.slug, 80), role: clip(p.workflow.role, 80), front: p.workflow.front === true, ...(clip(p.workflow.name, 80) ? { name: clip(p.workflow.name, 80) } : {}) } } : {}),
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
      .map((device) => ({ device, rows: (rows[device.node] ?? []).map((r) => ({ ...r, location: deviceLocation(device.node, device.name) })) }))
      .filter((g) => g.rows.length > 0 || g.device.state === 'not_allowed' || g.device.needs_person.length > 0);
  }, [enabled, view, rows]);

  return { view, enabled, groups, refresh };
}
