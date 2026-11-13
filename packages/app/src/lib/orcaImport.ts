// "Bring my projects from Orca": the types and the typed wrappers for the `orca_import_*` commands. The Rust side is
// src-tauri/src/import_orca. It reads Orca's own files on this PC, read-only. Nothing leaves this computer.
import { invoke } from '@tauri-apps/api/core';
import { LS_SIDEBAR_PROJECTS, readProjects, withProject, writeProjects } from './sidebarProjects';

export interface OrcaProject {
  path: string;
  name: string;
  /** The folder is on this PC now. */
  exists: boolean;
}

export interface OrcaChat {
  title: string;
  project: string;
}

export interface OrcaScan {
  found: boolean;
  projects: OrcaProject[];
  chats: OrcaChat[];
}

export interface OrcaImportApi {
  scan(): Promise<OrcaScan>;
  /** Asks the app which of these folders may be added (they must be in Orca's list and on this PC). */
  check(paths: string[]): Promise<OrcaProject[]>;
}

export const orcaImportApi: OrcaImportApi = {
  scan: () => invoke<OrcaScan>('orca_import_scan'),
  check: (projects) => invoke<OrcaProject[]>('orca_import_add', { projects }),
};

/**
 * Adds the folders to the sidebar's project list, the same list the sidebar's own "Add project" writes. The sidebar
 * listens for the storage event, so it shows them without a reload. Returns how many were new.
 */
export function addProjectsToSidebar(accepted: readonly OrcaProject[]): number {
  let list = readProjects();
  const before = list.length;
  for (const project of accepted) list = withProject(list, project.path);
  writeProjects(list);
  try {
    window.dispatchEvent(new StorageEvent('storage', { key: LS_SIDEBAR_PROJECTS }));
  } catch {
    /* an old webview: the list shows after the next start */
  }
  return list.length - before;
}
