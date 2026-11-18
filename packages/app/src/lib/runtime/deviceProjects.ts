// The projects of every other PC, as the New agent page's project picker lists them: one group per device, under its name.
// Each reachable device is asked for its folders once (`GET /pclink/projects`, by opaque id: a path never travels) and again when
// the picker opens. A device that is offline, asleep or does not let this PC in is still a group: greyed, with the reason, never
// asked. Nothing here knows an agent; the far PC's own answers are the list.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { cannotPickWhy, pcStatus, type Device, type DevicesApi, type DevicesView, type PcStatus } from '../devices';
import { makeRemoteClient } from './remote';
import type { PcProject } from './pclink';

export type DeviceGroupState = 'loading' | 'ready' | 'failed' | 'away';

export interface DeviceProjectGroup {
  node: string;
  name: string;
  status: PcStatus;
  /** Why the group cannot be used (offline, asleep, not let in), in the words of the Where picker; null when it can. */
  why: string | null;
  state: DeviceGroupState;
  /** Folders that exist there, newest first. */
  projects: PcProject[];
}

/** The groups, one per paired device (by name), and a `refresh` for when the picker opens. Off (`enabled` false): none. */
export function useDeviceProjects(view: DevicesView | null, api: Pick<DevicesApi, 'request'>, enabled: boolean): { groups: DeviceProjectGroup[]; refresh: () => void } {
  const [found, setFound] = useState<Record<string, { projects: PcProject[]; failed: boolean }>>({});
  const [tries, setTries] = useState(0);
  const devices = view?.devices ?? [];
  // Only a change in who is reachable asks again, not every new view of the same devices.
  const signature = devices.map((d) => `${d.node}:${cannotPickWhy(d) === null ? 'up' : 'away'}`).join('|');
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    for (const d of devices) {
      if (cannotPickWhy(d) !== null) continue;
      makeRemoteClient(d.node, api)
        .projects()
        .then(
          (projects) => live && setFound((prev) => ({ ...prev, [d.node]: { projects, failed: false } })),
          () => live && setFound((prev) => ({ ...prev, [d.node]: { projects: prev[d.node]?.projects ?? [], failed: true } })),
        );
    }
    return () => {
      live = false;
    };
    // `devices` itself is read through `signature`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, signature, tries, api]);
  const refresh = useCallback(() => setTries((n) => n + 1), []);
  const groups = useMemo<DeviceProjectGroup[]>(() => {
    if (!enabled) return [];
    return [...devices]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((d: Device) => {
        const why = cannotPickWhy(d);
        const mine = found[d.node];
        const state: DeviceGroupState = why !== null ? 'away' : !mine ? 'loading' : mine.failed && mine.projects.length === 0 ? 'failed' : 'ready';
        return { node: d.node, name: d.name, status: pcStatus(d), why, state, projects: (mine?.projects ?? []).filter((p) => p.state !== 'missing') };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, signature, view, found]);
  return { groups, refresh };
}
