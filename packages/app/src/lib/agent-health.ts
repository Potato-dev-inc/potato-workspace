// Agent doctor client: the `agents_health` / `agents_health_test` Tauri commands (same bodies as
// `GET /agents/health` and `POST /agents/health/test`).
import { invoke } from '@tauri-apps/api/core';
import type { Host } from './host/host';

export type HealthState = 'unchecked' | 'ready' | 'not_installed' | 'needs_login' | 'error';

/** Live updates (agent hooks) for one agent; `sentence` and `how_to` are already plain user text. */
export interface AgentHooksHealth {
  state: string;
  mode: string;
  sentence: string;
  how_to?: string;
  /** Off unless the user turns it on (its own switch in Settings > Agents). */
  opt_in?: boolean;
  /** What turning it on does. */
  opt_in_note?: string;
  /** On by the user's choice or the default. */
  enabled?: boolean;
}

export interface AgentHealth {
  id: string;
  label: string;
  state: HealthState;
  installed: boolean;
  version: string | null;
  /** Plain-language sentence for the state. */
  reason: string;
  install_hint: string | null;
  install_fallback?: string | null;
  login_hint: string | null;
  /** A deep check is possible for this agent. */
  can_test: boolean;
  hooks?: AgentHooksHealth | null;
}

export interface AgentHealthApi {
  check: () => Promise<AgentHealth[]>;
  test: (agentId: string) => Promise<AgentHealth>;
}

/** The doctor's two calls at one place (`agents_health` is a Watch row on a far PC; the deep `agents_health_test` is not served there). */
export function agentHealthApiFor(host: Pick<Host, 'invoke' | 'place'>): AgentHealthApi {
  if (host.place.kind === 'local') return agentHealthApi;
  return {
    check: async () => (await host.invoke<{ agents: AgentHealth[] }>('agents_health')).agents,
    test: (agentId) => host.invoke<AgentHealth>('agents_health_test', { agentId }),
  };
}

export const agentHealthApi: AgentHealthApi = {
  check: async () => {
    const body = await invoke<{ agents: AgentHealth[] }>('agents_health');
    return body.agents;
  },
  test: (agentId) => invoke<AgentHealth>('agents_health_test', { agentId }),
};

const SPAWNED_KEY = 'pm.cockpit.everSpawned';

/** True once any pane has ever been seen in this install (the first-run hint is hidden after that). */
export function hasEverSpawned(): boolean {
  try {
    return window.localStorage.getItem(SPAWNED_KEY) === '1';
  } catch {
    return true; // storage blocked: never nag
  }
}

export function markSpawned(): void {
  try {
    window.localStorage.setItem(SPAWNED_KEY, '1');
  } catch {
    /* ignore */
  }
}
