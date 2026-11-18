// The data sources of the normal New agent page, answered by another PC. `NewAgentPage` takes its data as parameters (`api`,
// `modelApi`, `defaultsApi`, `rulesApi`, `addonApi`, `agents`, `onStart`); this file builds those from the far PC's own answers
// (`GET /pclink/agents` and `/pclink/projects`, the model list, `POST /pclink/agents/start`, the chat settings route, the message
// route) over the PC link client of `lib/runtime/pclink.ts`. So the page is the same page on every PC: only where its answers come from changes.
//
// A remote project is an opaque id on the far PC (its path never travels). The page needs a "folder", so the adapter gives each
// project the pseudo path `remote:<id>` and maps it back to the id when the agent starts.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../i18n';
import type { AgentDescriptor } from '../agentRegistry';
import type { AcpAddonApi } from '../acpAddon';
import type { AgentRulesApi, EffectivePins } from '../agentRules';
import { PcLinkError, type PcLinkClient, type PcNewAgentOptions } from './pclink';
import { optionsFromWire, type AgentDefaultsApi, type ModelOptionsApi } from '../modelOptions';
import type { GitState, RecentProject } from '../ship-api';
import type { NewAgentApi } from '../../components/cockpit/newagent/api';
import type { LaneView, StartRequest } from '../../components/cockpit/newagent/model';

export const REMOTE_PROJECT_PREFIX = 'remote:';

/** The pseudo folder the page holds for a far project, and the id back from it (null for anything else). */
export const remotePathOf = (projectId: string): string => `${REMOTE_PROJECT_PREFIX}${projectId}`;
export const remoteProjectId = (path: string | undefined): string | null => (path && path.startsWith(REMOTE_PROJECT_PREFIX) ? path.slice(REMOTE_PROJECT_PREFIX.length) : null);

const GIT_STATES: readonly GitState[] = ['repo', 'no_commits', 'folder', 'missing'];
export const gitStateOf = (state: string): GitState => (GIT_STATES.includes(state as GitState) ? (state as GitState) : 'folder');

/** The far PC's agents as the registry rows the page draws. Nothing here names an agent. */
export function remoteAgents(options: PcNewAgentOptions): AgentDescriptor[] {
  return options.agents.map((a) => ({
    id: a.id,
    label: a.label,
    icon: null,
    kind: 'agent',
    source: 'remote',
    experimental: false,
    dispatchable: true,
    not_dispatchable_reason: null,
    installed: true,
    install_hint: null,
    modes: { headless: false, visible: true },
    features: { read_only_headless: false, read_only_spawned_pane: false, resumable_headless: false },
    run_options: { trust_workspace: false, allow_shell: false, shell_default_on: false, allowed_commands: false },
    standby: { visible: false, headless: false, experimental: false },
    definition: null,
  }));
}

/** The far PC's known projects as the page's recent list: first is newest. */
export function remoteRecents(options: PcNewAgentOptions): RecentProject[] {
  return options.projects
    .filter((p) => gitStateOf(p.state) !== 'missing')
    .map((p, i, all) => ({ path: remotePathOf(p.id), name: p.name, state: gitStateOf(p.state), last_used_ms: all.length - i }));
}

const NO_PINS: EffectivePins = { model: null, mode: null, force_yes: false, force_yes_source: null, notes: null, fences: [] };

/** What the page reads and writes while another PC is picked. */
export interface RemoteNewAgent {
  node: string;
  deviceName: string;
  /** The far PC's "Show terminals" setting (an older PC that does not say allows them). */
  terminals: boolean;
  agents: AgentDescriptor[];
  api: NewAgentApi;
  modelApi: ModelOptionsApi;
  defaultsApi: AgentDefaultsApi;
  rulesApi: Pick<AgentRulesApi, 'effective'>;
  addonApi: AcpAddonApi;
  onStart: (request: StartRequest) => Promise<string>;
  /** Warms the far chat program for this agent and folder (the phone does the same once both are picked). */
  warm: (agentId: string, folder: string) => void;
}

export interface RemoteDeps {
  client: PcLinkClient;
  deviceName: string;
  node: string;
  /** This PC may start things on the far PC (`full` level). Without it Start says so. Read when Start is pressed. */
  canControl: () => boolean;
  /** An agent was started there: open it. `chat` is false for a terminal. */
  onStarted: (paneId: string, chat: boolean) => void;
  /** One plain line for the person (the model could not be set). */
  notify?: (text: string) => void;
}

/** The sources for one loaded far PC. Pure: tests build it from a fake client. */
export function buildRemoteNewAgent(options: PcNewAgentOptions, deps: RemoteDeps): RemoteNewAgent {
  const { client } = deps;
  const recents = remoteRecents(options);
  const optionIds = new Map<string, string>();
  const lanes: LaneView = { labsEnabled: true, agents: options.agents.map((a) => ({ id: a.id, lane: a.chat ? ('acp' as const) : ('terminal' as const), disabled: false })) };
  const api: NewAgentApi = {
    recent: async () => recents,
    pickFolder: async () => null,
    pickPaths: async () => [],
    defaultFolder: async () => null,
    gitState: async (path) => recents.find((p) => p.path === path)?.state ?? 'folder',
    lanes: async () => lanes,
    accounts: async () => [],
    loadHome: async () => ({ name: '', cards: [] }),
    saveCards: async () => undefined,
    onHomeChanged: async () => () => undefined,
  };
  const modelApi: ModelOptionsApi = {
    get: async (agentId) => {
      const wire = await client.modelOptions(agentId);
      const id = (wire as { live?: { id?: unknown } } | null)?.live?.id;
      if (typeof id === 'string' && id) optionIds.set(agentId, id);else optionIds.delete(agentId);
      return optionsFromWire(wire as Parameters<typeof optionsFromWire>[0]);
    },
  };
  const name = deps.deviceName;
  // A chat that started but whose first message did not go: pressing Start again sends the message to it, not to a second chat.
  let started: { key: string; paneId: string } | null = null;
  const onStart = async (req: StartRequest): Promise<string> => {
    if (!deps.canControl()) throw new Error(t('newAgent.remote.watchOnly', { name }));
    const project = remoteProjectId(req.folder);
    if (!project) throw new Error(t('newAgent.remote.noAnswer', { name }));
    const key = `${req.agentId}|${project}|${req.runAs}`;
    let paneId: string;
    if (started && started.key === key) paneId = started.paneId;
    else {
      try {
        paneId = (await client.startAgent({ agent: req.agentId, project, lane: req.runAs === 'chat' ? 'chat' : 'terminal' })).pane_id;
      } catch (error) {
        if (error instanceof PcLinkError && error.status === 403) throw new Error(t('newAgent.remote.watchOnly', { name }));
        // The far PC answered but refused (400, 404, 500 ...): say what it said. No answer at all is "didn't answer".
        const why = error instanceof PcLinkError ? error.said : null;
        throw new Error(why ? t('newAgent.remote.refused', { name, why }) : t('newAgent.remote.noAnswer', { name }));
      }
      started = { key, paneId };
      // The model goes in before the first message, by the far chat's own setting name (known only when its list loaded).
      if (req.model && req.runAs === 'chat') {
        const optionId = optionIds.get(req.agentId);
        let ok = false;
        if (optionId) {
          try {
            await client.setConfig(paneId, optionId, req.model);
            ok = true;
          } catch {
            /* told below */
          }
        }
        if (!ok) deps.notify?.(t('chatFirst.modelNotSet', { model: req.model }));
      }
    }
    try {
      await client.sendMessage(paneId, req.prompt);
    } catch {
      throw new Error(t('newAgent.remote.msgNotSent', { name }));
    }
    started = null;
    deps.onStarted(paneId, req.runAs === 'chat');
    return paneId;
  };
  /** The agent and project are picked: the far PC starts that agent's chat program ahead of Start. */
  const warm = (agentId: string, folder: string) => {
    const project = remoteProjectId(folder);
    if (project) client.warm({ agent: agentId, project }).catch(() => undefined);
  };
  return {
    node: deps.node,
    deviceName: deps.deviceName,
    terminals: options.terminals !== false,
    agents: remoteAgents(options),
    api,
    modelApi,
    defaultsApi: { get: async () => ({}) },
    rulesApi: { effective: async () => NO_PINS },
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
    onStart,
    warm,
  };
}

export type RemoteStatus = 'loading' | 'failed' | 'ready';

/**
 * Reads the far PC's agents and projects once (and again on `retry`), and builds the page's sources from them. While it loads, or
 * when it failed, the sources are empty ones (so the page never reaches for this PC's own data), and `status` says which.
 */
export function useRemoteNewAgent(deps: RemoteDeps | null): { remote: RemoteNewAgent | null; status: RemoteStatus; retry: () => void } {
  const [state, setState] = useState<{ node: string | null; status: RemoteStatus; remote: RemoteNewAgent | null }>({ node: null, status: 'loading', remote: null });
  const [tries, setTries] = useState(0);
  const client = deps?.client ?? null;
  const node = deps?.node ?? null;
  // Start reads the newest callbacks, so a change in them never asks the far PC again.
  const latest = useRef(deps);
  latest.current = deps;
  const forward = useCallback(
    (d: RemoteDeps): RemoteDeps => ({ ...d, canControl: () => latest.current?.canControl() ?? false, onStarted: (paneId, chat) => latest.current?.onStarted(paneId, chat), notify: (text) => latest.current?.notify?.(text) }),
    [],
  );
  useEffect(() => {
    if (!client || !node) return undefined;
    let live = true;
    setState({ node, status: 'loading', remote: null });
    client.agentOptions().then(
      (options) => {
        const d = latest.current;
        if (live && d) setState({ node, status: 'ready', remote: buildRemoteNewAgent(options, forward(d)) });
      },
      () => live && setState({ node, status: 'failed', remote: null }),
    );
    return () => {
      live = false;
    };
  }, [client, node, tries, forward]);
  const retry = useCallback(() => setTries((n) => n + 1), []);
  const current = state.node === node ? state : { node, status: 'loading' as RemoteStatus, remote: null };
  const stub = useMemo(() => (deps ? buildRemoteNewAgent({ agents: [], projects: [] }, forward(deps)) : null), [client, node, forward]); // eslint-disable-line react-hooks/exhaustive-deps
  return { remote: current.remote ?? stub, status: current.status, retry };
}
