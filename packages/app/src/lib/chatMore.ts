// Four small chat features that share one thin layer over the PC: "Show earlier" (a page of the chat's journal), pictures
// the agent names, the draft that follows the person between the phone and the PC, and the sign-in without a terminal.
// The desktop reaches them through Tauri commands, the phone through the bridge (same checks on the PC). Pure helpers
// (no Tauri import beyond `invoke`) so both sides and the tests share them.
import { invoke } from '@tauri-apps/api/core';
import { localHost } from './host/local';
import type { Host } from './host/host';
import type { ChatItem } from './sessionChatModel';
import { mergeItems } from './sessionChatModel';

const isTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error(`Desktop shell required: ${command}`);
  return invoke<T>(command, args);
}

// ---------------------------------------------------------------------------------------------- Show earlier

/** Items one "Show earlier" press brings. */
export const EARLIER_PAGE = 50;

export interface EarlierPage {
  /** Oldest first. */
  items: ChatItem[];
  /** There is still more before the first of these. */
  more: boolean;
}

/** The kinds that stand in the order the conversation happened (the others, like the session line, keep one fixed id). */
const CHRONOLOGICAL = new Set<ChatItem['kind']>(['user', 'assistant', 'toolCall', 'toolResult', 'turnEnd', 'thinking']);

/** The id "Show earlier" asks before: the first item that is a message or a step, or null while there is none. */
export function earliestAnchor(items: readonly ChatItem[]): string | null {
  for (const item of items) if (CHRONOLOGICAL.has(item.kind)) return item.id;
  return null;
}

/** The older items go in front; an item held already keeps its newest copy and its place is the older one. */
export function prependItems(held: readonly ChatItem[], earlier: readonly ChatItem[]): ChatItem[] {
  return mergeItems(earlier, held, false);
}

export function chatEarlier(paneId: string, before: string, limit: number, host: Host = localHost): Promise<EarlierPage> {
  return host.invoke<EarlierPage>('chat_earlier', { paneId, before, limit });
}

// ---------------------------------------------------------------------------------------------- Pictures

export interface LoadedPicture {
  name: string;
  mime: string;
  size: number;
  /** A `data:` URL: the view never loads anything from the network or the disk. */
  dataUrl: string;
}

/** Where a chat's pictures come from (the PC checks every path). */
export interface PictureSource {
  /** Tells two sources apart, so a picture is not shown from another chat's cache. */
  key: string;
  load(path: string): Promise<LoadedPicture>;
}

export function desktopPictureSource(paneId: string, host: Host = localHost): PictureSource {
  return { key: `desk:${paneId}`, load: (path) => host.invoke<LoadedPicture>('chat_picture', { paneId, path }) };
}

// ---------------------------------------------------------------------------------------------- Draft

/** The PC's copy of a chat's half-written message. Read once when the box opens empty; written as the person types. */
export interface RemoteDraft {
  read(): Promise<string>;
  write(text: string): void;
}

export function desktopDraft(paneId: string): RemoteDraft {
  return {
    read: async () => (await call<{ text: string }>('chat_draft_get', { paneId })).text ?? '',
    write: (text) => void call('chat_draft_set', { paneId, text }).catch(() => undefined),
  };
}

// ---------------------------------------------------------------------------------------------- Sign-in

/** The hidden sign-in of the agent behind a chat (`commands/chat_signin.rs`). */
export interface SignInStatus {
  alive: boolean;
  asking: boolean;
  pane_id: string | null;
}

export interface ChatSignIn {
  /** Starts the agent's own sign-in in a hidden pane. Resolves to that pane's id (its terminal is shown under Details). */
  start(): Promise<string>;
  status(): Promise<SignInStatus>;
  stop(): Promise<void>;
}

export function desktopSignIn(chatPaneId: string, host?: Pick<Host, 'invoke'>): ChatSignIn {
  const run = <T,>(command: string, args: Record<string, unknown>): Promise<T> => (host ? host.invoke<T>(command, args) : call<T>(command, args));
  return {
    start: async () => (await run<{ pane_id: string }>('chat_signin_start', { pane_id: chatPaneId })).pane_id,
    status: () => run<SignInStatus>('chat_signin_status', { pane_id: chatPaneId }),
    stop: () => run<void>('chat_signin_stop', { pane_id: chatPaneId }),
  };
}
