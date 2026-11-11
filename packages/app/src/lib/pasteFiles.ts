// Files copied in Windows Explorer (Ctrl+C) reach the chat box as paths on the clipboard, which the webview does not
// show as files. This asks the desktop app for them. Behind an interface so the tests can use a fake clipboard.
import { invoke } from '@tauri-apps/api/core';
import { inDesktop } from './attachFiles';

export type FileClipboard = {
  /** The paths of the files on the clipboard, one per file (folders too). Empty when there are none. */
  filePaths(): Promise<string[]>;
};

/** The real clipboard: the desktop app reads the Windows file list. Empty outside the desktop app. */
export const tauriFileClipboard: FileClipboard = {
  async filePaths() {
    if (!inDesktop()) return [];
    const list = await invoke<string[] | null>('clipboard_file_paths');
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string' && p !== '') : [];
  },
};

let active: FileClipboard = tauriFileClipboard;

/** The clipboard the chat box reads files from. */
export function fileClipboard(): FileClipboard {
  return active;
}

/** Swaps the clipboard (tests use a fake one). Pass null to go back to the real clipboard. */
export function setFileClipboard(next: FileClipboard | null): void {
  active = next ?? tauriFileClipboard;
}
