// Reading a project that lives on another computer (SSH), read only: one folder, one text file, the git branch and the changed files.
// The Rust side (`ssh_fs_list`, `ssh_fs_read`, `ssh_git_status`) does everything and names only the chat pane: this screen never picks the
// machine or the root folder. Everything that comes back is text from the far machine: render it as text, never as markup.
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { t } from '../i18n';
import { errorSentence } from './sayError';

export interface FarEntry {
  name: string;
  kind: 'dir' | 'file' | 'link' | 'other';
}

export interface FarListing {
  /** The folder shown, relative to the project folder. */
  path: string;
  entries: FarEntry[];
  more: boolean;
  skipped: number;
}

export interface FarFile {
  path: string;
  size: number;
  text: string;
}

export type FarChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'new' | 'conflict' | 'changed';

export interface FarChange {
  path: string;
  kind: FarChangeKind;
  staged: boolean;
}

export interface FarStatus {
  branch: string | null;
  detached: boolean;
  unborn: boolean;
  ahead: number;
  behind: number;
  gone: boolean;
  changes: FarChange[];
  more: boolean;
}

export interface RemoteFsApi {
  list: (paneId: string, path: string, fresh?: boolean) => Promise<FarListing>;
  read: (paneId: string, path: string, fresh?: boolean) => Promise<FarFile>;
  status: (paneId: string, fresh?: boolean) => Promise<FarStatus>;
}

const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(new Error(`Desktop shell required: ${command}`));
  return invoke<T>(command, args);
}

export const remoteFsApi: RemoteFsApi = {
  list: (paneId, path, fresh) => call('ssh_fs_list', { paneId, path, fresh: fresh ?? false }),
  read: (paneId, path, fresh) => call('ssh_fs_read', { paneId, path, fresh: fresh ?? false }),
  status: (paneId, fresh) => call('ssh_git_status', { paneId, fresh: fresh ?? false }),
};

export type Loaded<T> = { state: 'loading' } | { state: 'ready'; data: T } | { state: 'error'; message: string; code?: string };

const codeOf = (e: unknown): string | undefined => (e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : undefined);

const ERR_KEYS = {
  BAD_FOLDER: 'devices.ssh.fs.err.BAD_FOLDER',
  BAD_PATH: 'devices.ssh.fs.err.BAD_PATH',
  NO_FOLDER: 'devices.ssh.fs.err.NO_FOLDER',
  ESCAPE: 'devices.ssh.fs.err.ESCAPE',
  NOT_FOLDER: 'devices.ssh.fs.err.NOT_FOLDER',
  NOT_FILE: 'devices.ssh.fs.err.NOT_FILE',
  LINK: 'devices.ssh.fs.err.LINK',
  TOO_BIG: 'devices.ssh.fs.err.TOO_BIG',
  BINARY: 'devices.ssh.fs.err.BINARY',
  UNREADABLE: 'devices.ssh.fs.err.UNREADABLE',
  NO_GIT: 'devices.ssh.fs.err.NO_GIT',
  NOT_REPO: 'devices.ssh.fs.err.NOT_REPO',
  NO_ANSWER: 'devices.ssh.fs.err.NO_ANSWER',
  BUSY: 'devices.ssh.fs.err.BUSY',
  TIMED_OUT: 'devices.ssh.fs.err.TIMED_OUT',
  HOST_KEY_UNKNOWN: 'devices.ssh.fs.err.HOST_KEY_UNKNOWN',
  HOST_KEY_CHANGED: 'devices.ssh.fs.err.HOST_KEY_CHANGED',
  WRONG_KEY: 'devices.ssh.fs.err.WRONG_KEY',
  CANNOT_REACH: 'devices.ssh.fs.err.CANNOT_REACH',
  OTHER: 'devices.ssh.fs.err.OTHER',
  NO_CHAT: 'devices.ssh.fs.err.NO_CHAT',
} as const;

/** What a failed read says, in the person's language when the backend gave a known reason, else the backend's own sentence. */
export function farErrorText(err: { message: string; code?: string }, name: string): string {
  const reason = err.code?.startsWith('SSH_FS_') ? err.code.slice('SSH_FS_'.length) : '';
  const key = (ERR_KEYS as Record<string, (typeof ERR_KEYS)[keyof typeof ERR_KEYS]>)[reason];
  return key ? t(key, { name }) : err.message;
}

/**
 * Loads `run()` when the screen opens, whenever `refreshKey` changes (a chat turn ending) and on `reload()`. It never polls: every
 * read is a full ssh connection. A newer request wins; an older answer that arrives late is dropped.
 */
export function useFar<T>(run: (fresh: boolean) => Promise<T>, refreshKey: string, deps: readonly unknown[], enabled = true): { value: Loaded<T>; reload: () => void } {
  const [value, setValue] = useState<Loaded<T>>({ state: 'loading' });
  const latest = useRef(0);
  const runRef = useRef(run);
  runRef.current = run;
  const load = useCallback((fresh: boolean) => {
    const mine = ++latest.current;
    setValue((v) => (v.state === 'ready' ? v : { state: 'loading' }));
    runRef.current(fresh).then(
      (data) => mine === latest.current && setValue({ state: 'ready', data }),
      (e: unknown) => mine === latest.current && setValue({ state: 'error', message: errorSentence(e), code: codeOf(e) }),
    );
  }, []);
  const first = useRef(true);
  // Another pane, folder or file is another thing: never show the old one's answer while the new one loads.
  useEffect(() => {
    setValue({ state: 'loading' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);
  useEffect(() => {
    if (!enabled) return undefined;
    // A new turn or a new place asks the machine again; the first load may use what was just read.
    load(!first.current);
    first.current = false;
    return () => {
      latest.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, refreshKey, ...deps]);
  return { value, reload: useCallback(() => load(true), [load]) };
}

/** The folder of a remote chat as the far machine knows it: the pane's marker is `\0ssh://<machine id>/path`, shown as `/path`. */
export function farFolderOf(cwd: string): string {
  const m = /^\0ssh:\/\/[A-Za-z0-9-]+(.*)$/s.exec(cwd);
  return m ? m[1] : cwd;
}

export function sizeWords(size: number): { key: 'devices.ssh.fs.sizeKb' | 'devices.ssh.fs.sizeBytes'; vars: Record<string, string | number> } {
  return size >= 1024 ? { key: 'devices.ssh.fs.sizeKb', vars: { kb: (size / 1024).toFixed(size >= 10 * 1024 ? 0 : 1) } } : { key: 'devices.ssh.fs.sizeBytes', vars: { n: size } };
}

/**
 * A number that goes up each time a chat turn ENDS (the status goes back to idle). The panel reads again then, not at the start of a
 * turn and not on a timer: every read is a full ssh connection.
 */
export function useTurnEnds(status: string): string {
  const before = useRef(status);
  const [ends, setEnds] = useState(0);
  useEffect(() => {
    if (before.current !== 'idle' && status === 'idle') setEnds((n) => n + 1);
    before.current = status;
  }, [status]);
  return String(ends);
}
