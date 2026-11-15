// The chat's view mode: Summary (the person's messages, the final answers and the activity lines), Normal (activity
// lines collapsed) or Verbose (every row open with its detail). Remembered per pane in localStorage. A pane that has no
// choice of its own uses the global default (Settings > Agents > Chat), which is Summary until the person changes it.
import { useState, useSyncExternalStore } from 'react';

export type ChatViewMode = 'summary' | 'normal' | 'verbose';

export const CHAT_VIEW_MODES: readonly ChatViewMode[] = ['summary', 'normal', 'verbose'];

export const CHAT_VIEW_LABEL: Record<ChatViewMode, string> = {
  summary: 'Summary',
  normal: 'Normal',
  verbose: 'Verbose',
};

/** Anything that is not a known mode (an old or broken value) is Normal. */
export function parseChatViewMode(value: unknown): ChatViewMode {
  return CHAT_VIEW_MODES.includes(value as ChatViewMode) ? (value as ChatViewMode) : 'normal';
}

const storageKey = (paneId: string) => `pm.chatView.${paneId}`;

export const CHAT_VIEW_DEFAULT_KEY = 'potato.chatViewDefault.v1';

function readDefault(): ChatViewMode {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(CHAT_VIEW_DEFAULT_KEY);
    return CHAT_VIEW_MODES.includes(raw as ChatViewMode) ? (raw as ChatViewMode) : 'summary';
  } catch {
    return 'summary';
  }
}

let defaultMode = readDefault();
const defaultListeners = new Set<() => void>();

/** The mode a chat starts in when the person never chose one for it: Summary unless Settings says otherwise. */
export const getChatViewDefault = (): ChatViewMode => defaultMode;

export function setChatViewDefault(mode: ChatViewMode): void {
  defaultMode = mode;
  try {
    localStorage.setItem(CHAT_VIEW_DEFAULT_KEY, mode);
  } catch {
    // Not saved: the choice still holds until the app is closed.
  }
  for (const listener of defaultListeners) listener();
}

function subscribeDefault(listener: () => void): () => void {
  defaultListeners.add(listener);
  return () => {
    defaultListeners.delete(listener);
  };
}

export function useChatViewDefault(): [ChatViewMode, (mode: ChatViewMode) => void] {
  return [useSyncExternalStore(subscribeDefault, getChatViewDefault, getChatViewDefault), setChatViewDefault];
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== CHAT_VIEW_DEFAULT_KEY) return;
    defaultMode = readDefault();
    for (const listener of defaultListeners) listener();
  });
}

/** The pane's own saved mode (kept as it was), else the global default. No pane, or no storage: the default. */
export function readChatViewMode(paneId: string | null | undefined): ChatViewMode {
  if (!paneId) return defaultMode;
  try {
    const saved = localStorage.getItem(storageKey(paneId));
    return CHAT_VIEW_MODES.includes(saved as ChatViewMode) ? (saved as ChatViewMode) : defaultMode;
  } catch {
    return defaultMode;
  }
}

export function writeChatViewMode(paneId: string | null | undefined, mode: ChatViewMode): void {
  if (!paneId) return;
  try {
    localStorage.setItem(storageKey(paneId), mode);
  } catch {
    // Not saved: the mode still holds until the chat is closed.
  }
}

/** The mode of a pane's chat and a setter that also remembers it. A new pane reads its own saved mode. */
export function useChatViewMode(paneId: string | null | undefined): [ChatViewMode, (mode: ChatViewMode) => void] {
  const pane = paneId ?? null;
  const [state, setState] = useState(() => ({ pane, mode: readChatViewMode(pane) }));
  let current = state;
  if (state.pane !== pane) {
    current = { pane, mode: readChatViewMode(pane) };
    setState(current);
  }
  const setMode = (mode: ChatViewMode) => {
    writeChatViewMode(pane, mode);
    setState({ pane, mode });
  };
  return [current.mode, setMode];
}
