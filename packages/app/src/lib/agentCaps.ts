// What each agent can do, as the app has proof of it (SPEC-ADD-AGENT-1113 section 1): thin wrappers over the
// `agent_caps_get` / `agent_caps_list` commands, and the pure rules the chips follow.
// Nothing here names an agent. A chip is a pure function of the capability: the screen never upgrades it.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { CHIPS, type AgentCaps, type Cap, type ChipKey, type Tri } from './addAgent';

export { CHIPS, sourceText } from './addAgent';
export type { AgentCaps, Cap, ChipKey, Tri } from './addAgent';

export interface AgentCapsApi {
  get: (agentId: string) => Promise<AgentCaps>;
  list: () => Promise<AgentCaps[]>;
  /** Runs `onChange` when the app learns something new about an agent. Returns the way to stop listening. */
  onChanged: (onChange: (agentId: string) => void) => () => void;
}

const inTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const agentCapsApi: AgentCapsApi = {
  get: (agentId) => invoke<AgentCaps>('agent_caps_get', { agentId }),
  list: () => invoke<AgentCaps[]>('agent_caps_list', undefined),
  onChanged: (onChange) => {
    if (!inTauri()) return () => undefined;
    let off: (() => void) | null = null;
    let stopped = false;
    void listen<{ agent_id?: string }>('agent-caps://changed', (event) => onChange(event.payload?.agent_id ?? ''))
      .then((fn) => {
        if (stopped) fn();
        else off = fn;
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
      off?.();
    };
  },
};

/**
 * What a capability shows as. A yes or a no needs a source: a value with no source is shown as not seen yet,
 * so a tick is never drawn without proof.
 */
export function shownValue(cap: Cap | undefined): Tri {
  if (!cap || cap.source === 'unknown') return 'unknown';
  return cap.value;
}

export interface ChipView {
  key: ChipKey;
  label: string;
  value: Tri;
  cap: Cap | undefined;
}

/** The chips of one agent: the known ones first (yes, then no), then the ones not seen yet. Order inside each kind is the spec's. */
export function chipViews(caps: AgentCaps | null | undefined): { known: ChipView[]; unknown: ChipView[] } {
  const all: ChipView[] = CHIPS.map(({ key, label }) => ({ key, label, cap: caps?.[key], value: shownValue(caps?.[key]) }));
  return {
    known: [...all.filter((c) => c.value === 'yes'), ...all.filter((c) => c.value === 'no')],
    unknown: all.filter((c) => c.value === 'unknown'),
  };
}

/** True when the app has proof this agent cannot chat here: it works in a terminal window only. */
export function terminalOnly(caps: AgentCaps | null | undefined): boolean {
  return shownValue(caps?.chat) === 'no';
}
