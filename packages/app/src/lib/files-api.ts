// Typed wrappers for the project-folder commands (`commands/files_view.rs`). Every path is relative to the pane's
// project folder, with `/`. The Rust side refuses anything that leaves the folder; this file only names the calls.
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { t } from '../i18n';
import type { Host } from './host/host';
import { forHost } from './host/hostApi';

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
  /** A stamp of what the file held when it was read; a save sends it back so a change on disk is noticed. */
  version?: string;
}

/** A file's raw bytes (base64) for the Word, Excel and PDF viewers. */
export interface FileBytes {
  path: string;
  name: string;
  size: number;
  kind: 'bytes' | 'too_large';
  base64?: string | null;
}

/** Where a viewer gets a file's bytes: a stream address (the `pmfile` protocol), or the bytes themselves (tests, dev). */
export type FileSource = { url: string } | { bytes: Uint8Array };

/** A Word, Excel or PDF file for the viewer. The bytes are not in it: they stream from `source`. */
export interface FileStream {
  path: string;
  name: string;
  size: number;
  kind: 'stream' | 'too_large';
  /** The biggest size that opens (bytes). */
  limit: number;
  source?: FileSource;
}

/** The streaming address of one file of a pane's project (see `commands/files_stream.rs`). */
export function streamUrl(paneId: string, path: string): string {
  return convertFileSrc(`${paneId}/${path}`, 'pmfile');
}

/** What a save reports. */
export interface FileSaved {
  path: string;
  size: number;
  /** The stamp of what was written. */
  version: string;
}

/** `M` changed, `N` new. A path ending in `/` is a whole new folder. */
export interface FileMark {
  path: string;
  mark: 'M' | 'N';
}

/** One line of a file that has the words searched for. */
export interface ContentHit {
  path: string;
  name: string;
  /** 1-based. */
  line: number;
  /** The line, trimmed. */
  text: string;
  /** The match inside `text` (characters; `end` is exclusive). */
  start: number;
  end: number;
}

/** What "search inside files" found. */
export interface ContentSearch {
  hits: ContentHit[];
  /** There were more matching lines than the list holds (200). */
  truncated: boolean;
  /** The search was stopped before it finished. */
  cancelled: boolean;
  filesScanned: number;
}

/** "Show in folder" and "Open in its own app" act on the disk of a PC: for a file on another PC they cannot, and this says so. `path` is the file's place in its project, for Copy path. */
export class OnOtherPc extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
  }
}

/** The calls the Files card and the file tab need (a test double can stand in). */
export interface FilesApi {
  list(paneId: string, path: string, showHeavy?: boolean): Promise<FolderListing>;
  read(paneId: string, path: string): Promise<FileContent>;
  /** The raw bytes (15 MB at most); the Rust side refuses a path outside the project folder. */
  readBytes(paneId: string, path: string): Promise<FileBytes>;
  /** A Word, Excel or PDF file: its size, and where its bytes stream from (500 MB at most). */
  openBytes(paneId: string, path: string): Promise<FileStream>;
  /** Opens the file in the program the system chose for it (Word for .docx). */
  openDefault(paneId: string, path: string): Promise<void>;
  marks(paneId: string): Promise<FileMark[]>;
  /** Searches the text inside the project's files. A newer search with the same `searchId` stops the older one. */
  searchContents(paneId: string, query: string, searchId: string): Promise<ContentSearch>;
  /** Stops a running search. */
  cancelSearch(searchId: string): Promise<void>;
  reveal(paneId: string, path: string): Promise<void>;
  /** A unified diff of the file against the last commit ("" when nothing changed). */
  diff(paneId: string, path: string): Promise<string>;
  /**
   * Saves text over a file of the project. `baseVersion` is the version it was opened at; when the file is different
   * on disk now, the call fails with a `FILES_CONFLICT` sentence unless `overwrite` is true.
   */
  write(paneId: string, path: string, text: string, baseVersion: string | null, overwrite?: boolean): Promise<FileSaved>;
}

export const filesApi: FilesApi = {
  list: (paneId, path, showHeavy) => invoke<FolderListing>('files_list', { paneId, path, showHeavy }),
  read: (paneId, path) => invoke<FileContent>('files_read', { paneId, path }),
  readBytes: (paneId, path) => invoke<FileBytes>('files_read_bytes', { paneId, path }),
  openBytes: async (paneId, path) => {
    const info = await invoke<Omit<FileStream, 'source'> & { url?: string }>('files_open_bytes', { paneId, path });
    return { ...info, source: info.kind === 'stream' ? { url: info.url ?? streamUrl(paneId, info.path) } : undefined };
  },
  openDefault: (paneId, path) => invoke<void>('files_open_default', { paneId, path }),
  marks: (paneId) => invoke<FileMark[]>('files_marks', { paneId }),
  searchContents: (paneId, query, searchId) => invoke<ContentSearch>('files_search_contents', { paneId, query, searchId }),
  cancelSearch: (searchId) => invoke<void>('files_search_cancel', { searchId }),
  reveal: (paneId, path) => invoke<void>('files_reveal', { paneId, path }),
  diff: (paneId, path) => invoke<string>('files_diff', { paneId, path }),
  write: (paneId, path, text, baseVersion, overwrite) => invoke<FileSaved>('files_write', { paneId, path, text, baseVersion, overwrite: overwrite ?? false }),
};

/** The biggest file another PC's Word, Excel and PDF viewers get (its `files_read_bytes` cap); the same limit the far PC holds. */
const FAR_BYTES_LIMIT = 15 * 1024 * 1024;

/** The same api over another PC's host: every call is one far call (`pclink/calls_files.rs`). A file opens as its bytes (it cannot stream from a disk that is not here), and a call the far PC does not have (show in Explorer, open in the default program) says so in the host's one sentence. */
function farFilesApi(host: Host): FilesApi {
  const call = <T,>(cmd: string, args: Record<string, unknown>) => host.invoke<T>(cmd, args);
  const name = host.place.kind === 'pc' ? host.place.name : '';
  return {
    list: (paneId, path, showHeavy) => call<FolderListing>('files_list', { paneId, path, showHeavy }),
    read: (paneId, path) => call<FileContent>('files_read', { paneId, path }),
    readBytes: (paneId, path) => call<FileBytes>('files_read_bytes', { paneId, path }),
    openBytes: async (paneId, path) => {
      const file = await call<FileBytes>('files_read_bytes', { paneId, path });
      if (file.kind === 'too_large') return { path: file.path, name: file.name, size: file.size, kind: 'too_large', limit: FAR_BYTES_LIMIT };
      return { path: file.path, name: file.name, size: file.size, kind: 'stream', limit: FAR_BYTES_LIMIT, source: { bytes: bytesOf(file.base64 ?? '') } };
    },
    // A window on the other PC's screen cannot be opened from here, so neither is asked: the file is there, and this says so.
    openDefault: (_paneId, path) => Promise.reject(new OnOtherPc(t('files.openOnOtherPc', { name }), path)),
    marks: (paneId) => call<FileMark[]>('files_marks', { paneId }),
    searchContents: (paneId, query, searchId) => call<ContentSearch>('files_search_contents', { paneId, query, searchId }),
    cancelSearch: (searchId) => call<void>('files_search_cancel', { searchId }),
    reveal: (_paneId, path) => Promise.reject(new OnOtherPc(t('files.revealOnOtherPc', { name }), path)),
    diff: (paneId, path) => call<string>('files_diff', { paneId, path }),
    write: (paneId, path, text, baseVersion, overwrite) => call<FileSaved>('files_write', { paneId, path, text, baseVersion, overwrite: overwrite ?? false }),
  };
}

/** The files api of a place: this PC's own, or the same calls on another PC. */
export const filesApiFor = (host: Host): FilesApi => forHost(host, filesApi, farFilesApi);

/** Size in plain words: "412 KB", "1.8 MB". */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The bytes of a source (a stream address is fetched; `Range` is for a part). */
export async function bytesOfSource(source: FileSource, range?: string): Promise<ArrayBuffer> {
  if ('bytes' in source) {
    const b = source.bytes;
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  }
  const res = await fetch(source.url, range ? { headers: { Range: range } } : undefined);
  if (!res.ok) throw new Error(`stream ${res.status}`);
  return res.arrayBuffer();
}

/** Base64 as bytes. */
export function bytesOf(base64: string): Uint8Array {
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
