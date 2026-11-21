// Start and warm-up of the normal New agent page, answered by another PC. What the page READS from that PC (agents, lanes, folders,
// models, default models, pins) now comes through its host (`lib/host/newAgentSources.ts`, the far call rows of `pclink/calls.rs`). What
// is left here is what only the far side can do: start an agent (`POST /pclink/agents/start`), warm it up, and say whether the far PC
// shows terminals.
//
// A remote project is an opaque handle on the far PC (its path never travels). The page needs a "folder", so each far project is
// `remote:<id>` (the far PC's `project_recent` says so) and the handle is mapped back to the id when the agent starts.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../i18n';
import { PcLinkError, type PcLinkClient, type PcNewAgentOptions } from './pclink';
import type { GitState } from '../ship-api';
import type { StartRequest } from '../../components/cockpit/newagent/model';

/** The plain shells ("New terminal"): never an agent, so never a chat or a first message. */
const SHELLS = ['cmd', 'powershell', 'bash'];

export const REMOTE_PROJECT_PREFIX = 'remote:';

/** The pseudo folder the page holds for a far project, and the id back from it (null for anything else). */
export const remotePathOf = (projectId: string): string => `${REMOTE_PROJECT_PREFIX}${projectId}`;
export const remoteProjectId = (path: string | undefined): string | null => (path && path.startsWith(REMOTE_PROJECT_PREFIX) ? path.slice(REMOTE_PROJECT_PREFIX.length) : null);

const GIT_STATES: readonly GitState[] = ['repo', 'no_commits', 'folder', 'missing'];
export const gitStateOf = (state: string): GitState => (GIT_STATES.includes(state as GitState) ? (state as GitState) : 'folder');

/** What the page reads and writes while another PC is picked. */
export interface RemoteNewAgent {
  node: string;
  deviceName: string;
  /** The far PC's "Show terminals" setting (an older PC that does not say allows them). */
  terminals: boolean;
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

/** Start, warm-up and the terminals flag for one loaded far PC. Pure: tests build it from a fake client. */
export function buildRemoteNewAgent(options: PcNewAgentOptions, deps: RemoteDeps): RemoteNewAgent {
  const { client } = deps;
  const name = deps.deviceName;
  // A chat that started but whose first message did not go: pressing Start again sends the message to it, not to a second chat.
  let started: { key: string; paneId: string } | null = null;
  const onStart = async (req: StartRequest): Promise<string> => {
    if (!deps.canControl()) throw new Error(t('newAgent.remote.watchOnly', { name }));
    const project = remoteProjectId(req.folder);
    if (!project) throw new Error(t('newAgent.remote.noAnswer', { name }));
    // A plain shell is "New terminal": the far PC's own login shell, by the terminal call (its cap and audit apply there).
    if (SHELLS.includes(req.agentId)) {
      let shell: string;
      try {
        shell = await client.call<string>('spawn_pane', { args: { agent_type: 'shell', cwd: project } });
      } catch (error) {
        if (error instanceof PcLinkError && error.status === 403) throw new Error(t('newAgent.remote.watchOnly', { name }));
        const why = error instanceof PcLinkError ? error.said : null;
        throw new Error(why ? t('newAgent.remote.refused', { name, why }) : t('newAgent.remote.noAnswer', { name }));
      }
      deps.onStarted(shell, false);
      return shell;
    }
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
      // The model goes in before the first message, by the far chat's own setting name (read from its model list).
      if (req.model && req.runAs === 'chat') {
        let ok = false;
        try {
          const live = ((await client.modelOptions(req.agentId)) as { live?: { id?: unknown } } | null)?.live?.id;
          if (typeof live === 'string' && live) {
            await client.setConfig(paneId, live, req.model);
            ok = true;
          }
        } catch {
          /* told below */
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
    onStart,
    warm,
  };
}

export type RemoteStatus = 'loading' | 'failed' | 'ready';

/**
 * Reads the far PC's start-up facts once (and again on `retry`) and builds Start and warm-up from them. While it loads, or when it
 * failed, Start is the stub's, and `status` says which.
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
