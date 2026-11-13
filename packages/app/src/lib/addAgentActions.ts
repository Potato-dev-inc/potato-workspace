// The buttons on the Add-an-agent result ("Start a chat", "Open in a terminal", "Open {Name}") live in Settings, but
// the panes live in the cockpit. Settings asks through this small store; the cockpit's host (AddAgentActionHost)
// answers it. When Settings is its own window there is no host in that window, so the ask goes out as an app event
// the cockpit window listens for. Nothing here names an agent.
import { emit, listen } from '@tauri-apps/api/event';
import { useSyncExternalStore } from 'react';

export type AddAgentActionKind = 'chat' | 'terminal';
export interface AddAgentActionRequest {
  kind: AddAgentActionKind;
  agentId: string;
  nonce: number;
}

export const ADD_AGENT_ACTION_EVENT = 'add-agent://action';

let pending: AddAgentActionRequest | null = null;
let nonce = 0;
let hosts = 0;
const listeners = new Set<() => void>();
const emitChange = () => {
  for (const l of [...listeners]) l();
};

/** Ask for a chat or a terminal pane for `agentId`. Safe to call from any window. */
export function requestAddAgentAction(kind: AddAgentActionKind, agentId: string): void {
  if (hosts > 0) {
    pending = { kind, agentId, nonce: ++nonce };
    emitChange();
    return;
  }
  // No host in this window: tell the other windows. A plain browser has no events, which is fine.
  void emit(ADD_AGENT_ACTION_EVENT, { kind, agentId }).catch(() => undefined);
}

export function useAddAgentActionRequest(): AddAgentActionRequest | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pending,
  );
}

export function clearAddAgentActionRequest(request: AddAgentActionRequest): void {
  if (pending?.nonce !== request.nonce) return;
  pending = null;
  emitChange();
}

/** A host calls this while it is mounted; it also feeds events from other windows into the store. */
export function registerAddAgentActionHost(): () => void {
  hosts += 1;
  let stop: (() => void) | null = null;
  let gone = false;
  void listen<{ kind: AddAgentActionKind; agentId: string }>(ADD_AGENT_ACTION_EVENT, (e) => {
    const { kind, agentId } = e.payload ?? ({} as { kind?: AddAgentActionKind; agentId?: string });
    if ((kind === 'chat' || kind === 'terminal') && typeof agentId === 'string' && agentId) {
      pending = { kind, agentId, nonce: ++nonce };
      emitChange();
    }
  })
    .then((fn) => (gone ? fn() : (stop = fn)))
    .catch(() => undefined);
  return () => {
    gone = true;
    hosts -= 1;
    stop?.();
  };
}
