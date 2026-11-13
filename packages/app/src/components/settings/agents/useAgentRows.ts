// The data the Agents list and an agent's page draw: the registered agents, how each stands (installed, signed in)
// and what the app has proof each can do. Each source fails on its own: no desktop shell means no chips, not no list.
import { useEffect, useState } from 'react';
import { agentCapsApi, type AgentCaps, type AgentCapsApi } from '../../../lib/agentCaps';
import { agentHealthApi, type AgentHealth, type AgentHealthApi, type HealthState } from '../../../lib/agent-health';
import { useAgentRegistry } from '../../../lib/agentRegistry';

export interface AgentRow {
  id: string;
  label: string;
  /** The agent's own mark, if the registry gave one. */
  icon: string | null;
  installed: boolean;
  /** `unchecked` until the health check answers. */
  state: HealthState;
  version: string | null;
  loginHint: string | null;
  /** A deep check is possible (the "Check" button). */
  canTest: boolean;
  caps: AgentCaps | null;
}

export interface AgentRowsApi {
  caps: AgentCapsApi;
  health: AgentHealthApi;
}

// Looked up when called, so a test (or a screen test that mocks one of these modules in part) never trips on import.
export const defaultRowsApi: AgentRowsApi = {
  caps: { get: (id) => agentCapsApi.get(id), list: () => agentCapsApi.list(), onChanged: (cb) => agentCapsApi.onChanged(cb) },
  health: { check: () => agentHealthApi.check(), test: (id) => agentHealthApi.test(id) },
};

/** One short phrase for how the agent stands. "Ready" is not "signed in": the check only says it can start. */
export function standingWords(row: Pick<AgentRow, 'installed' | 'state'>): string {
  if (!row.installed || row.state === 'not_installed') return 'Not installed';
  switch (row.state) {
    case 'ready':
      return 'Ready';
    case 'needs_login':
      return 'Not signed in';
    case 'error':
      return 'Did not start';
    default:
      return 'Not checked yet';
  }
}

export type NextStep = { label: 'Sign in' | 'Install' | 'Check'; kind: 'signin' | 'install' | 'check' };

/** The one next step a row offers beside its words; null when the agent is ready (or cannot be checked). */
export function nextStep(row: Pick<AgentRow, 'installed' | 'state' | 'canTest'>): NextStep | null {
  if (!row.installed || row.state === 'not_installed') return { label: 'Install', kind: 'install' };
  if (row.state === 'needs_login') return { label: 'Sign in', kind: 'signin' };
  if ((row.state === 'unchecked' || row.state === 'error') && row.canTest) return { label: 'Check', kind: 'check' };
  return null;
}

/** The agents, one row each. Shells are not agents and are left out. */
export function useAgentRows(api: AgentRowsApi = defaultRowsApi): { rows: AgentRow[]; refreshCaps: (agentId: string) => void; recheck: (agentId: string) => Promise<void> } {
  const registry = useAgentRegistry();
  const [health, setHealth] = useState<AgentHealth[]>([]);
  const [caps, setCaps] = useState<Record<string, AgentCaps>>({});

  useEffect(() => {
    let alive = true;
    api.health
      .check()
      .then((all) => alive && setHealth(all))
      .catch(() => undefined);
    api.caps
      .list()
      .then((all) => alive && setCaps(Object.fromEntries(all.map((c) => [c.agent_id, c]))))
      .catch(() => undefined);
    const off = api.caps.onChanged((agentId) => {
      if (!agentId) return;
      api.caps
        .get(agentId)
        .then((c) => alive && setCaps((cur) => ({ ...cur, [agentId]: c })))
        .catch(() => undefined);
    });
    return () => {
      alive = false;
      off();
    };
  }, [api]);

  const refreshCaps = (agentId: string) => {
    api.caps
      .get(agentId)
      .then((c) => setCaps((cur) => ({ ...cur, [agentId]: c })))
      .catch(() => undefined);
  };

  // "Check now": the deep check of one agent; its answer replaces that agent's line.
  const recheck = async (agentId: string): Promise<void> => {
    const fresh = await api.health.test(agentId);
    setHealth((cur) => (cur.some((h) => h.id === agentId) ? cur.map((h) => (h.id === agentId ? fresh : h)) : [...cur, fresh]));
  };

  const rows = registry.agents
    .filter((a) => a.kind !== 'shell')
    .map<AgentRow>((a) => {
      const h = health.find((x) => x.id === a.id);
      return {
        id: a.id,
        label: a.label,
        icon: a.icon,
        installed: a.installed,
        state: h?.state ?? 'unchecked',
        version: h?.version ?? caps[a.id]?.program_version ?? null,
        loginHint: h?.login_hint ?? null,
        canTest: h?.can_test ?? false,
        caps: caps[a.id] ?? null,
      };
    });
  return { rows, refreshCaps, recheck };
}
