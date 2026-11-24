// Closed chats: chats the person closed. They stay on disk, so they can be reopened or deleted for good.
// The Rust side is `acp/closed.rs`; the commands are in `commands/acp_conversations.rs`.
import { invoke } from '@tauri-apps/api/core';
import { type UnlistenFn } from '@tauri-apps/api/event';
import { listen } from './events';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Host } from './host/host';
import { idOfKey, placeKey } from './host/placeKey';

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
  /** The name of the PC it lives on, when it is not this one: the small "where" badge. Absent on this PC. */
  where?: string;
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

/** The closed chats of the place `host` shows. A far chat's id is its key here (`dev:<node>:<id>`), so it never meets one of this PC's. */
export const closedChatsApiOf = (host: Host): ClosedChatsApi => {
  if (host.place.kind !== 'pc') return tauriClosedChatsApi;
  const { node, name } = host.place;
  return {
    list: async () => ((await host.invoke<ClosedChat[]>('acp_closed_list')) ?? []).map((c) => ({ ...c, id: placeKey(host.place, c.id), where: name })),
    reopen: async (id) => placeKey(host.place, await host.invoke<string>('acp_reopen_closed', { id: idOfKey(node, id) })),
    remove: (id) => host.invoke<void>('acp_delete_closed', { id: idOfKey(node, id) }),
    // The far PC has no delete-all row: its closed chats are listed and deleted one by one (each an audited Full call). A chat it refuses stays, uncounted.
    // A PC that does not list them has none shown here (0); one that lists them and refuses a delete (below Full) keeps that chat, and the refusal is raised after the rest.
    removeAll: async () => {
      const listed = await host.invoke<ClosedChat[]>('acp_closed_list').catch(() => [] as ClosedChat[]);
      let gone = 0;
      let refused: unknown;
      for (const c of listed ?? []) {
        try {
          await host.invoke<void>('acp_delete_closed', { id: c.id });
          gone += 1;
        } catch (error) {
          refused ??= error;
        }
      }
      if (refused !== undefined) throw refused;
      return gone;
    },
    watch: async () => () => undefined,
  };
};

/**
 * This PC's closed chats and those of the other PCs in one list, newest first, each far one carrying its PC's name. A PC that does not
 * answer (offline, or it lets this PC see nothing) adds nothing and never hides the rest. Reopen and delete go to the PC that owns the chat.
 */
export function closedChatsAcross(local: ClosedChatsApi, hosts: readonly Host[]): ClosedChatsApi {
  const far = hosts.flatMap((h) => (h.place.kind === 'pc' ? [{ prefix: placeKey(h.place, ''), api: closedChatsApiOf(h) }] : []));
  if (far.length === 0) return local;
  const owner = (id: string) => far.find((f) => id.startsWith(f.prefix))?.api ?? local;
  return {
    list: async () => {
      const lists = await Promise.all([local.list(), ...far.map((f) => f.api.list().catch(() => [] as ClosedChat[]))]);
      return lists.flat().sort((a, b) => b.updated_ms - a.updated_ms);
    },
    reopen: (id) => owner(id).reopen(id),
    remove: (id) => owner(id).remove(id),
    // Every place's chats go, this PC's first; a place that refuses never stops the rest, and its refusal is raised once they are done.
    removeAll: async () => {
      const done = await Promise.allSettled([local.removeAll(), ...far.map((f) => f.api.removeAll())]);
      const refused = done.find((d): d is PromiseRejectedResult => d.status === 'rejected');
      if (refused) throw refused.reason;
      return done.reduce((sum, d) => sum + (d.status === 'fulfilled' ? d.value : 0), 0);
    },
    watch: local.watch,
  };
}

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
