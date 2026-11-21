// The sign-in terminal's data at one place: this PC's `tauri` wrappers, or the far pane io the pane registry uses for another PC
// (`farPanes.ts`, served by `pclink/terminal.rs`). One far terminal path; nothing parallel here.
import type { OwnerReplayDeps } from '../../terminal';
import type { TerminalTransport } from '../../hooks/useTerminalSession';
import { tauri } from '../tauri';
import type { PtyResizedEvent } from '../tauri-types';
import { farPaneIo, type PaneBytes } from './farPanes';
import type { Host, Unlisten } from './host';

export interface TerminalFeed {
  replay: OwnerReplayDeps;
  onData: (cb: (e: PaneBytes) => void) => Promise<Unlisten>;
  onResized: (cb: (e: PtyResizedEvent) => void) => Promise<Unlisten>;
  /** Absent for this PC (the terminal's own default sends to this PC). */
  transport?: (paneId: string) => TerminalTransport;
}

export function terminalFeedFor(host: Host): TerminalFeed {
  if (host.place.kind === 'local') {
    return {
      replay: { readScreen: tauri.readScreenReplay, readRaw: tauri.readRawBuffer, pendingResize: tauri.pendingResize },
      onData: tauri.onTerminalData,
      onResized: tauri.onPtyResized,
    };
  }
  const io = farPaneIo(host);
  return {
    replay: { readScreen: io.readScreenReplay, readRaw: io.readRawBuffer, pendingResize: io.pendingResize },
    onData: io.onTerminalData,
    onResized: io.onPtyResized,
    transport: (paneId) => ({ resize: (cols, rows) => io.resize(paneId, cols, rows), writeInput: (text, appendNewline) => io.writeInput(paneId, text, appendNewline) }),
  };
}
