// A terminal pane on ANOTHER PC, as the pane registry (`usePaneRegistry`) wants it: the same verbs the local registry gets from
// `tauri`, run on a host. The far side is `pclink/terminal.rs` (the `// ---- P2.3 terminal ----` rows). Nothing here draws a
// terminal: `TerminalViewport` draws the far pane exactly as it draws a local one.
import type { PaneInfo, PtyResizedEvent } from '../tauri-types';
import type { Host, Unlisten } from './host';

/** A chunk of a pane's output (`terminal-data`): the same event the window gets, with bytes instead of a number list. */
export interface PaneBytes {
  pane_id: string;
  data: Uint8Array | number[];
  offset?: number;
}

export interface PaneScreenReplay {
  data: number[];
  cols: number;
  rows: number;
  offset?: number;
}

/** What the pane registry needs from a place: this PC's `tauri` has all of it, and so does `farPaneIo(host)`. */
export interface PaneIo {
  listPanes: () => Promise<PaneInfo[]>;
  spawnPane: (args: { agent_type: string; cwd?: string; cols?: number; rows?: number; extra_args?: string[]; pane_id?: string }) => Promise<string>;
  killPane: (paneId: string) => Promise<void>;
  killAllPanes: () => Promise<void>;
  writeInput: (paneId: string, text: string, appendNewline?: boolean) => Promise<void>;
  resize: (paneId: string, cols: number, rows: number) => Promise<void>;
  readScreenReplay: (paneId: string) => Promise<PaneScreenReplay | null>;
  readRawBuffer: (paneId: string, lines: number) => Promise<number[]>;
  pendingResize: (paneId: string) => Promise<unknown> | undefined;
  onPanesChanged: (cb: (e: unknown) => void) => Promise<Unlisten>;
  onTerminalData: (cb: (e: PaneBytes) => void) => Promise<Unlisten>;
  onPtyResized: (cb: (e: PtyResizedEvent) => void) => Promise<Unlisten>;
  /** The far PC dropped output it could not send in time: the viewer redraws from the screen. Local panes never lag. */
  onTerminalLag?: (cb: (paneId: string) => void) => Promise<Unlisten>;
}

/** The far pane list is read again this often (a far pane's status and size ride no event). */
export const FAR_PANES_POLL_MS = 3000;

export const bytesOfBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export function farPaneIo(host: Host): PaneIo {
  const resizing = new Map<string, Promise<unknown>>();
  // The grid this window last asked a far pane for: the far PC tells every viewer about a resize, ours included, and the echo is not news.
  const asked = new Map<string, string>();
  // Below Full the far PC refuses keys and resizes (403): the viewer only watches, so they are not sent.
  const may = host.caps.terminal;
  return {
    // Listing a far PC's terminals names folders: only a place that may use its terminals lists them.
    listPanes: async () => (host.caps.terminal ? host.invoke<PaneInfo[]>('list_panes') : []),
    spawnPane: ({ agent_type, cwd, cols, rows }) => host.invoke<string>('spawn_pane', { args: { agent_type, cwd, cols, rows } }),
    killPane: (paneId) => host.invoke<void>('kill_pane_cmd', { paneId }),
    killAllPanes: () => Promise.reject(new Error('Close the terminals one by one on another PC.')),
    writeInput: async (paneId, text, appendNewline = true) => {
      if (may) await host.invoke<void>('write_pane_input', { paneId, args: { text, append_newline: appendNewline } });
    },
    resize: (paneId, cols, rows) => {
      if (!may) return Promise.resolve();
      asked.set(paneId, `${cols}x${rows}`);
      const call = host.invoke<void>('resize_pane', { paneId, cols, rows });
      const tracked: Promise<unknown> = call.catch(() => undefined).finally(() => {
        if (resizing.get(paneId) === tracked) resizing.delete(paneId);
      });
      resizing.set(paneId, tracked);
      return call;
    },
    // Output and screen may hold secrets: the far PC shows them at Full only (S11), so below Full nothing is asked.
    readScreenReplay: async (paneId) => (may ? host.invoke<PaneScreenReplay>('read_pane_screen_replay', { paneId }) : null),
    readRawBuffer: async (paneId, lines) => (may ? host.invoke<number[]>('read_pane_raw_buffer', { paneId, lines }) : []),
    pendingResize: (paneId) => resizing.get(paneId),
    onPanesChanged: async (cb) => {
      const timer = setInterval(() => cb(null), FAR_PANES_POLL_MS);
      return () => clearInterval(timer);
    },
    onTerminalData: (cb) => host.listen<{ pane_id: string; b64: string; offset?: number | null }>('terminal-data', (e) => cb({ pane_id: e.pane_id, data: bytesOfBase64(e.b64), offset: e.offset ?? undefined })),
    onPtyResized: (cb) =>
      host.listen<PtyResizedEvent>('pty://resized', (e) => {
        const ours = asked.get(e.pane_id) === `${e.cols}x${e.rows}`;
        asked.delete(e.pane_id);
        if (!ours) cb({ ...e, offset: e.offset ?? undefined });
      }),
    onTerminalLag: (cb) => host.listen<{ pane_id: string }>('terminal-lag', (e) => cb(e.pane_id)),
  };
}
