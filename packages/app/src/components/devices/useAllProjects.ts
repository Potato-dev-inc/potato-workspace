import { useMemo } from 'react';
import { remoteId } from '../../lib/devices';
import { LOCAL, deviceLocation, type ProjectLocation } from '../../lib/projectLocation';
import { pathKey, projectLabel, type SidebarProject } from '../../lib/sidebarProjects';
import type { DeviceGroup, RemoteRow } from './useDeviceGroups';

/** One row of the merged Projects list: a folder on this PC, or a folder of another device seen through its link. */
export interface ProjectEntry {
  /** Local: the folder's path key. Remote: `dev:<node>:<project id>`, the same family as its chats' keys. */
  key: string;
  name: string;
  /** The folder on this PC; null for a remote project (its path stays on that device). */
  path: string | null;
  location: ProjectLocation;
  /** Remote only: the project's opaque id on that device (what its New agent page picks by). */
  projectId?: string;
  /** Remote only: that device's chats and panes in this project, each with its own `dev:<node>:<id>` key. */
  rows: RemoteRow[];
}

/** A device's panes grouped by folder, like the sidebar's Projects on this PC (the order the far PC listed them in). */
export function projectsOf(rows: RemoteRow[]): { key: string; name: string; rows: RemoteRow[] }[] {
  const byFolder = new Map<string, RemoteRow[]>();
  const keyOf = (r: RemoteRow) => r.project || r.cwd || '';
  for (const r of rows) byFolder.set(keyOf(r), [...(byFolder.get(keyOf(r)) ?? []), r]);
  return [...byFolder.entries()].map(([key, list]) => ({ key: key || '-', name: list[0]?.cwd || '·', rows: list }));
}

/** Local projects first (as given), then every online or remembered device's projects, each tagged with where it lives. */
export function mergeProjects(local: readonly SidebarProject[], groups: readonly DeviceGroup[]): ProjectEntry[] {
  const out: ProjectEntry[] = local.map((p) => ({ key: pathKey(p.path), name: projectLabel(p), path: p.path, location: p.location ?? LOCAL, rows: [] }));
  for (const g of groups) {
    const location = deviceLocation(g.device.node, g.device.name);
    for (const p of projectsOf(g.rows)) out.push({ key: remoteId(g.device.node, p.key), name: p.name, path: null, location, projectId: p.key, rows: p.rows });
  }
  return out;
}

/** The one list for the sidebar's Projects: pass this PC's added projects and the device groups (one poller, in CockpitApp). */
export function useAllProjects(local: readonly SidebarProject[], groups: readonly DeviceGroup[]): ProjectEntry[] {
  return useMemo(() => mergeProjects(local, groups), [local, groups]);
}
