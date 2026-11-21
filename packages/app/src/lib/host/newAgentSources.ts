// What the New agent page reads, for the PC it is shown on. This PC keeps its own commands (the page's defaults). Another PC answers the
// same reads through `host.invoke` (the far call rows of `pclink/calls.rs`, `// ---- P2.1 agents/projects ----`): its agents, lanes,
// folders, models, default models and pins, in the same shapes, so the page is the same page. Only what has no far row yet is empty
// here: the system dialogs and home cards are this window's own, accounts are never read from another PC, and add-ons wait for their rows.
import { useEffect, useState } from 'react';
import { listingFromBody, useAgentRegistry, type AgentDescriptor } from '../agentRegistry';
import { optionsFromWire, defaultsFromSettings, type AgentDefaultsApi, type ModelOptionsApi } from '../modelOptions';
import type { AgentRulesApi } from '../agentRules';
import type { AcpAddonApi } from '../acpAddon';
import type { RecentProject } from '../ship-api';
import { laneViewFromWire, workflowsOf, type NewAgentApi } from '../../components/cockpit/newagent/api';
import type { Host } from './host';
import { remoteProjectId } from '../runtime/remoteNewAgent';

export interface NewAgentSources {
  api: NewAgentApi;
  modelApi: ModelOptionsApi;
  defaultsApi: AgentDefaultsApi;
  rulesApi: Pick<AgentRulesApi, 'effective'>;
  addonApi: AcpAddonApi;
}

const isLocal = (host: Host): boolean => host.place.kind === 'local';

/** The page's sources on another PC; `null` for this PC (the page uses its own). Build once per host. */
export function hostNewAgentSources(host: Host): NewAgentSources | null {
  if (isLocal(host)) return null;
  const call = <T,>(cmd: string, args: Record<string, unknown> = {}) => host.invoke<T>(cmd, args);
  const api: NewAgentApi = {
    recent: () => call<RecentProject[]>('project_recent', { limit: 8 }),
    // Workflows: this far PC's own crews and plans (P3.1 rows). A far folder is its handle without the prefix.
    ...workflowsOf(host, (paneId, text) => call('pane_message_send', { paneId, text }), (folder) => remoteProjectId(folder) ?? folder),
    pickFolder: async () => null,
    pickPaths: async () => [],
    defaultFolder: async () => null,
    gitState: async () => 'folder', // a far folder arrives with its state; this is only the fallback
    lanes: async () => laneViewFromWire(await call('agent_lane_get')),
    accounts: async () => [], // shortcut: logins never cross devices; the far PC's own sign-in choices need a safe row (P2.2)
    loadHome: async () => ({ name: '', cards: [] }),
    saveCards: async () => undefined,
    onHomeChanged: async () => () => undefined,
  };
  return {
    api,
    modelApi: { get: async (agentId) => optionsFromWire(await call('agent_model_options', { agentId })) },
    defaultsApi: { get: async () => defaultsFromSettings(await call('agent_default_models')) },
    rulesApi: { effective: (agent, project) => call('agent_rules_effective', { agent, project }) },
    addonApi: {
      list: async () => ({ labsEnabled: false, addons: [] }),
      install: async () => {
        throw new Error('not here');
      },
      remove: async () => {
        throw new Error('not here');
      },
      watch: async () => () => undefined,
    },
  };
}

/** The agents of the PC this subtree shows: this PC's registry, or the other PC's own `agents_list` (installed or not, like here). */
export function useHostAgents(host: Host): readonly AgentDescriptor[] {
  const here = useAgentRegistry().agents;
  const [far, setFar] = useState<AgentDescriptor[] | null>(null);
  const local = isLocal(host);
  useEffect(() => {
    if (local) return undefined;
    let live = true;
    setFar(null);
    host.invoke<unknown>('agents_list').then(
      (body) => live && setFar(listingFromBody(body)?.agents ?? []),
      () => live && setFar([]),
    );
    return () => {
      live = false;
    };
  }, [host, local]);
  return local ? here : (far ?? []);
}
