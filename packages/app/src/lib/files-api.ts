// Typed wrappers for the project-folder commands (`commands/files_view.rs`). Every path is relative to the pane's
// project folder, with `/`. The Rust side refuses anything that leaves the folder; this file only names the calls.
import { invoke } from '@tauri-apps/api/core';

export interface FileEntry {
  name: string;
  /** Relative to the project folder. */
  path: string;
  isDir: boolean;
  size: number;
}

export interface FolderListing {
  entries: FileEntry[];
  /** The folder had more entries than the list holds. */
  truncated: boolean;
}

export type FileKind = 'text' | 'image' | 'binary' | 'too_large';

export interface FileContent {
  path: string;
  name: string;
  size: number;
  kind: FileKind;
  text?: string | null;
  dataUrl?: string | null;
}

/** `M` changed, `N` new. A path ending in `/` is a whole new folder. */
export interface FileMark {
  path: string;
  mark: 'M' | 'N';
}

/** The calls the Files card and the file tab need (a test double can stand in). */
export interface FilesApi {
  list(paneId: string, path: string, showHeavy?: boolean): Promise<FolderListing>;
  read(paneId: string, path: string): Promise<FileContent>;
  marks(paneId: string): Promise<FileMark[]>;
  reveal(paneId: string, path: string): Promise<void>;
  /** A unified diff of the file against the last commit ("" when nothing changed). */
  diff(paneId: string, path: string): Promise<string>;
}

export const filesApi: FilesApi = {
  list: (paneId, path, showHeavy) => invoke<FolderListing>('files_list', { paneId, path, showHeavy }),
  read: (paneId, path) => invoke<FileContent>('files_read', { paneId, path }),
  marks: (paneId) => invoke<FileMark[]>('files_marks', { paneId }),
  reveal: (paneId, path) => invoke<void>('files_reveal', { paneId, path }),
  diff: (paneId, path) => invoke<string>('files_diff', { paneId, path }),
};

/** Size in plain words: "412 KB", "1.8 MB". */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
