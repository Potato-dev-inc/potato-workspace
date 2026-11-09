// Closed chats: chats the person closed. They stay on disk, so they can be reopened or deleted for good.
// The Rust side is `acp/closed.rs`; the commands are in `commands/acp_conversations.rs`.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface ClosedChat {
  id: string;
  agent: string;
  /** The agent's name for people. */
  label: string;
  /** The project folder the chat worked in. */
  cwd: string;
  updated_ms: number;
  /** The first thing the person said, if it is known. */
  title: string | null;
}

export interface ClosedChatsApi {
  list: () => Promise<ClosedChat[]>;
  /** Brings the chat back as a chat pane; resolves with the pane id. */
  reopen: (id: string) => Promise<string>;
  remove: (id: string) => Promise<void>;
  removeAll: () => Promise<number>;
  /** Fires when chats were reopened or deleted. */
  watch: (cb: () => void) => Promise<UnlistenFn>;
}

const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const tauriClosedChatsApi: ClosedChatsApi = {
  list: async () => (isTauri() ? ((await invoke<ClosedChat[]>('acp_closed_list')) ?? []) : []),
  reopen: (id) => invoke<string>('acp_reopen_closed', { id }),
  remove: (id) => invoke<void>('acp_delete_closed', { id }),
  removeAll: () => invoke<number>('acp_delete_all_closed'),
  watch: async (cb) => {
    if (!isTauri()) return () => undefined;
    try {
      return await listen('acp-conversations-changed', () => cb());
    } catch {
      return () => undefined;
    }
  },
};

/** The last folder name of a path, with either kind of slash. */
export function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/**
 * The closed chats, read again when `refreshKey` changes (a pane was closed or opened) and when the backend says
 * conversations changed. A failed read keeps the last list.
 */
export function useClosedChats(api: ClosedChatsApi, refreshKey: string): { chats: ClosedChat[]; reload: () => void } {
  const [chats, setChats] = useState<ClosedChat[]>([]);
  const alive = useRef(true);
  const reload = useCallback(() => {
    api.list().then(
      (list) => alive.current && setChats(list),
      () => undefined,
    );
  }, [api]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    reload();
  }, [reload, refreshKey]);
  useEffect(() => {
    let off: UnlistenFn | null = null;
    let gone = false;
    api.watch(reload).then(
      (un) => {
        if (gone) un();
        else off = un;
      },
      () => undefined,
    );
    return () => {
      gone = true;
      off?.();
    };
  }, [api, reload]);
  return { chats, reload };
}
