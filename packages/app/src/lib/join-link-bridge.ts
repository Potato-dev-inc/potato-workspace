// Turns an invite link the desktop shell received from the OS into the `pm:join-link` window event the Join popup
// listens for. The shell has already checked the link; it is checked again here (`parseJoinLink`) because it is
// outside text, and the popup checks once more before it asks the Worker anything.
import { JOIN_LINK_EVENT, parseJoinLink } from './join-link';

/** The Tauri event the shell sends (src-tauri/src/deep_link.rs `EVENT`). */
export const SHELL_JOIN_EVENT = 'pm-join-link';

export interface JoinBridgeDeps {
  listen: (event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>;
  /** Asks the shell for a link that arrived before this window was ready; also clears it. */
  takePending: () => Promise<unknown>;
}

const announce = (link: unknown): void => {
  if (typeof link === 'string' && link.startsWith('potato-workspace://join/') && parseJoinLink(link)) {
    window.dispatchEvent(new CustomEvent(JOIN_LINK_EVENT, { detail: link }));
  }
};

const inTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function tauriDeps(): Promise<JoinBridgeDeps> {
  const [{ listen }, { invoke }] = await Promise.all([import('@tauri-apps/api/event'), import('@tauri-apps/api/core')]);
  return { listen: (event, handler) => listen(event, handler), takePending: () => invoke('take_pending_join_link') };
}

/** Starts listening; returns the stop function. Outside the desktop app it does nothing. */
export function startJoinLinkBridge(deps?: JoinBridgeDeps): () => void {
  if (!deps && !inTauri()) return () => undefined;
  let stopped = false;
  let unlisten: (() => void) | null = null;
  void (async () => {
    try {
      const d = deps ?? (await tauriDeps());
      const off = await d.listen(SHELL_JOIN_EVENT, (e) => {
        announce(e.payload);
        void d.takePending().catch(() => undefined);
      });
      if (stopped) off();
      else unlisten = off;
      // A link that came before this window was ready (the app was started by the link).
      const waiting = await d.takePending();
      if (!stopped) announce(waiting);
    } catch {
      // No shell or no link: nothing to show.
    }
  })();
  return () => {
    stopped = true;
    unlisten?.();
  };
}
