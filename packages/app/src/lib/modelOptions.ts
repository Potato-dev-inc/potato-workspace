// The models an agent can start on, for the model pickers (New agent page, Settings > Agents > Helper agents).
// One command, `agent_model_options`; the answer is kept for the session so a second picker does not ask again.
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useMemo, useState } from 'react';

/** `agent_model_options`: what one agent offers. */
export interface ModelOptions {
  /** A terminal pane can start on a model (the agent has a launch flag for it). Chats always can. */
  terminal: boolean;
  /** The model the agent uses when none is asked for, if it can be told. */
  defaultModel: string | null;
  /** Models worth listing, best known first. Empty: the picker offers a typed id. */
  models: string[];
  /** The agent's own list as it last sent it (the chat picker's list), with names and descriptions. null: never reported. */
  live?: LiveModel[] | null;
  /** The agent definition's own preset names (what a terminal launch flag knows); `models` is the live ids when there are any. */
  presetModels?: string[];
}

/** One model the agent itself offers: `value` is what a chat is told, exactly as the chat picker sends it. */
export interface LiveModel {
  value: string;
  name: string;
  description: string | null;
}

export type ModelListState = { status: 'loading' } | { status: 'ready'; options: ModelOptions } | { status: 'failed' };

export interface ModelOptionsApi {
  get: (agentId: string) => Promise<ModelOptions>;
}

interface Wire {
  terminal?: unknown;
  default_model?: unknown;
  models?: unknown;
  live?: unknown;
}

/** The agent's `configOptions` model entry as a list; anything that is not a plain list of named choices is "never reported". */
export function liveFromWire(live: unknown): LiveModel[] | null {
  const list = (live as { options?: unknown } | null | undefined)?.options;
  if (!Array.isArray(list) || list.length < 2) return null;
  const out: LiveModel[] = [];
  for (const o of list) {
    const { value, name, description } = (o ?? {}) as Record<string, unknown>;
    if (typeof value !== 'string' || typeof name !== 'string') return null;
    out.push({ value, name, description: typeof description === 'string' && description.trim() ? description : null });
  }
  return out;
}

/** The command's answer as ModelOptions. Anything odd is "nothing known". */
export function optionsFromWire(wire: Wire | null | undefined): ModelOptions {
  const models = Array.isArray(wire?.models) ? [...new Set(wire.models.filter((m): m is string => typeof m === 'string' && m.trim() !== '').map((m) => m.trim()))] : [];
  const def = typeof wire?.default_model === 'string' && wire.default_model.trim() ? wire.default_model.trim() : null;
  const live = liveFromWire(wire?.live);
  // With a live list the ids to remember and check against are the agent's own.
  return { terminal: wire?.terminal === true, defaultModel: def, models: live ? live.map((m) => m.value) : models, live, presetModels: models };
}

/** A list without the agent's own models: what a terminal pane takes (the launch flag knows the preset names). */
export function presetOnly(options: ModelOptions): ModelOptions {
  return options.live ? { ...options, live: null, models: options.presetModels ?? options.models } : options;
}

// ----- the last list the agent sent, kept per agent so it survives restarts and shows while a fresh one loads -----

const LIVE_KEY = 'pm.agent.models.live';

export function readCachedOptions(agentId: string): ModelOptions | null {
  try {
    const raw = localStorage.getItem(`${LIVE_KEY}.${agentId.toLowerCase()}`);
    return raw ? optionsFromWire(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeCachedOptions(agentId: string, options: ModelOptions): void {
  try {
    if (options.live) localStorage.setItem(`${LIVE_KEY}.${agentId.toLowerCase()}`, JSON.stringify({ terminal: options.terminal, default_model: options.defaultModel, models: options.presetModels ?? [], live: { options: options.live } }));
  } catch {
    /* a convenience only */
  }
}

const cache = new Map<string, { at: number; hit: Promise<ModelOptions> }>();
/** A fresh look is taken after this long: a chat may have reported a newer list meanwhile. */
const FRESH_MS = 30_000;

export const tauriModelOptionsApi: ModelOptionsApi = {
  get: (agentId) => {
    const key = agentId.toLowerCase();
    let entry = cache.get(key);
    if (!entry || Date.now() - entry.at > FRESH_MS) {
      const hit = invoke<Wire>('agent_model_options', { agentId }).then(optionsFromWire).then((o) => {
        writeCachedOptions(agentId, o);
        return o;
      });
      // A failure is not remembered: the next look asks again.
      hit.catch(() => cache.delete(key));
      entry = { at: Date.now(), hit };
      cache.set(key, entry);
    }
    return entry.hit;
  },
};

/** The list for one agent: loading, then ready or failed. A new agent starts loading again. */
export function useModelOptions(agentId: string | null, api: ModelOptionsApi = tauriModelOptionsApi): ModelListState {
  const [state, setState] = useState<{ agentId: string | null; value: ModelListState }>({ agentId: null, value: { status: 'loading' } });
  // While the answer loads, the last list this agent sent (kept on this computer) is shown.
  const cached = useMemo(() => (agentId ? readCachedOptions(agentId) : null), [agentId]);
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
  if (agentId && state.agentId === agentId) return state.value.status === 'failed' && cached ? { status: 'ready', options: cached } : state.value;
  return cached ? { status: 'ready', options: cached } : { status: 'loading' };
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
