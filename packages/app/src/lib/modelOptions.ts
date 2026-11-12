// The models an agent can start on, for the model pickers (New agent page, Settings > Agents > Helper agents).
// One command, `agent_model_options`; the answer is kept for the session so a second picker does not ask again.
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';

/** `agent_model_options`: what one agent offers. */
export interface ModelOptions {
  /** A terminal pane can start on a model (the agent has a launch flag for it). Chats always can. */
  terminal: boolean;
  /** The model the agent uses when none is asked for, if it can be told. */
  defaultModel: string | null;
  /** Models worth listing, best known first. Empty: the picker offers a typed id. */
  models: string[];
}

export type ModelListState = { status: 'loading' } | { status: 'ready'; options: ModelOptions } | { status: 'failed' };

export interface ModelOptionsApi {
  get: (agentId: string) => Promise<ModelOptions>;
}

interface Wire {
  terminal?: unknown;
  default_model?: unknown;
  models?: unknown;
}

/** The command's answer as ModelOptions. Anything odd is "nothing known". */
export function optionsFromWire(wire: Wire | null | undefined): ModelOptions {
  const models = Array.isArray(wire?.models) ? [...new Set(wire.models.filter((m): m is string => typeof m === 'string' && m.trim() !== '').map((m) => m.trim()))] : [];
  const def = typeof wire?.default_model === 'string' && wire.default_model.trim() ? wire.default_model.trim() : null;
  return { terminal: wire?.terminal === true, defaultModel: def, models };
}

const cache = new Map<string, Promise<ModelOptions>>();

export const tauriModelOptionsApi: ModelOptionsApi = {
  get: (agentId) => {
    const key = agentId.toLowerCase();
    let hit = cache.get(key);
    if (!hit) {
      hit = invoke<Wire>('agent_model_options', { agentId }).then(optionsFromWire);
      // A failure is not remembered: the next look asks again.
      hit.catch(() => cache.delete(key));
      cache.set(key, hit);
    }
    return hit;
  },
};

/** The list for one agent: loading, then ready or failed. A new agent starts loading again. */
export function useModelOptions(agentId: string | null, api: ModelOptionsApi = tauriModelOptionsApi): ModelListState {
  const [state, setState] = useState<{ agentId: string | null; value: ModelListState }>({ agentId: null, value: { status: 'loading' } });
  useEffect(() => {
    if (!agentId) return undefined;
    let live = true;
    api
      .get(agentId)
      .then((options) => live && setState({ agentId, value: { status: 'ready', options } }))
      .catch(() => live && setState({ agentId, value: { status: 'failed' } }));
    return () => {
      live = false;
    };
  }, [agentId, api]);
  return agentId && state.agentId === agentId ? state.value : { status: 'loading' };
}

// ----- the person's Default model per agent (Settings > Agents) -----

export interface AgentDefaultsApi {
  get: () => Promise<Record<string, string>>;
}

/** The saved map as text values only, keyed by lower-case agent id. */
export function defaultsFromSettings(saved: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return out;
  for (const [id, model] of Object.entries(saved as Record<string, unknown>)) {
    if (typeof model === 'string' && model.trim() !== '') out[id.trim().toLowerCase()] = model.trim();
  }
  return out;
}

export const tauriAgentDefaultsApi: AgentDefaultsApi = {
  get: async () => {
    const { loadSettings } = await import('./settings');
    return defaultsFromSettings((await loadSettings()).agent_default_models);
  },
};

/** The saved Default models, read when the page opens. Until then (or when unreadable) there are none. */
export function useAgentDefaults(api: AgentDefaultsApi = tauriAgentDefaultsApi): Record<string, string> {
  const [map, setMap] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    api
      .get()
      .then((m) => live && setMap(m))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api]);
  return map;
}

// ----- the last model picked on the New agent page, per agent (and sign-in) -----

const KEY = 'pm.newagent.model';
const slot = (agentId: string, accountId?: string): string => `${KEY}.${agentId.toLowerCase()}${accountId ? `:${accountId}` : ''}`;

/** The model last picked for this agent and sign-in; '' (the default) when none or storage is blocked. */
export function readPickedModel(agentId: string, accountId?: string): string {
  try {
    return localStorage.getItem(slot(agentId, accountId)) ?? '';
  } catch {
    return '';
  }
}

export function writePickedModel(agentId: string, accountId: string | undefined, model: string): void {
  try {
    if (model) localStorage.setItem(slot(agentId, accountId), model);
    else localStorage.removeItem(slot(agentId, accountId));
  } catch {
    /* a convenience only */
  }
}
