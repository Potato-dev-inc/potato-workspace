// Which chat panes run on another computer over SSH. Their folder is a folder of THAT computer, so everything that reads this
// PC's disk for a pane (the file tree, changes, branches, review) must not be shown for them: it would list local files.
// The backend knows (a chat started with a machine keeps it); the screen that starts one notes it here at once, and
// `loadRemotePanes` asks the backend at start-up and after a window reload, so a pane is never taken for a local one.
// The backend also refuses to read a remote pane's folder on this PC (`acp::chat::NOT_ON_THIS_PC`), whatever this says.
import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';

export interface RemotePane {
  hostId: string;
  name: string;
}

let remote = new Map<string, RemotePane>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

export function markRemotePane(paneId: string, hostId: string, name: string): void {
  remote = new Map(remote).set(paneId, { hostId, name });
  changed();
}

export function forgetRemotePane(paneId: string): void {
  if (!remote.has(paneId)) return;
  remote = new Map(remote);
  remote.delete(paneId);
  changed();
}

/** The machine a chat pane runs on, or null for a pane on this PC. */
export function remotePaneHost(paneId: string | null | undefined): RemotePane | null {
  return (paneId && remote.get(paneId)) || null;
}

/** The same, as a hook: the screen redraws when a pane is noted or the backend's list arrives. */
export function useRemotePane(paneId: string | null | undefined): RemotePane | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => remotePaneHost(paneId),
  );
}

/** Reads the chats that run on an SSH machine from the backend (start-up, and after a window reload). Never throws. */
export async function loadRemotePanes(ask: () => Promise<{ paneId: string; hostId: string; name: string }[]> = () => invoke('ssh_remote_panes')): Promise<void> {
  try {
    const list = await ask();
    if (!Array.isArray(list)) return;
    const next = new Map(remote);
    for (const p of list) if (p && typeof p.paneId === 'string') next.set(p.paneId, { hostId: String(p.hostId ?? ''), name: String(p.name ?? '') });
    remote = next;
    changed();
  } catch {
    /* not in the desktop shell: only the panes started on this screen are known */
  }
}
