// The data the Agents list and an agent's page draw: the registered agents, how each stands (installed, signed in)
// and what the app has proof each can do. Each source fails on its own: no desktop shell means no chips, not no list.
import { useEffect, useMemo, useState } from 'react';
import { useHost } from '../../../lib/host/context';
import { t } from '../../../i18n';
import { agentCapsApi, type AgentCaps, type AgentCapsApi } from '../../../lib/agentCaps';
import { agentHealthApi, agentHealthApiFor, type AgentHealth, type AgentHealthApi, type HealthState } from '../../../lib/agent-health';
import { useAgentRegistry } from '../../../lib/agentRegistry';
import { agentReadiness, type AgentReadiness } from '../../../lib/agentReadiness';
import { rememberTest, type TestMemory } from '../../../lib/setup-checks/test-memory';
import type { UsageRow } from '../../../lib/usage';
import type { OwnLogin } from './ownSignIn';

export interface AgentRow {
  id: string;
  label: string;
  /** The agent's own mark, if the registry gave one. */
  icon: string | null;
  installed: boolean;
  /** `unchecked` until the health check answers. */
  state: HealthState;
  version: string | null;
  /** The quick check's own sentence (why it did not start). */
  reason?: string;
  loginHint: string | null;
  /** A deep check is possible (the "Check" button). */
  canTest: boolean;
  caps: AgentCaps | null;
  /** A deep check of this agent is running right now. */
  checking?: boolean;
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

/** How a row stands, from the one place that says it (`agentReadiness`): the same words on the card, its page, the Overview and the rest. */
export function rowReadiness(row: Pick<AgentRow, 'id' | 'label' | 'installed' | 'state' | 'reason' | 'canTest' | 'checking'>, logins: readonly OwnLogin[] | null, tests: TestMemory, usage?: readonly UsageRow[]): AgentReadiness {
  if (row.checking) return { state: 'not_checked', label: t('agentPage.checking'), detail: null };
  const health = { id: row.id, label: row.label, installed: row.installed, state: row.state, reason: row.reason ?? '', can_test: row.canTest };
  return agentReadiness(row.id, { health: [health], logins, tests, usage });
}

export type NextStep = { label: 'Sign in' | 'Install' | 'Check'; kind: 'signin' | 'install' | 'check' };

/** The one next step a row offers beside its words; null when the agent is ready (or cannot be checked). */
export function nextStep(row: Pick<AgentRow, 'canTest'>, standing: AgentReadiness): NextStep | null {
  if (standing.state === 'not_installed') return { label: 'Install', kind: 'install' };
  if (standing.state === 'needs_sign_in') return { label: 'Sign in', kind: 'signin' };
  if ((standing.state === 'not_checked' || standing.state === 'broken' || standing.state === 'signed_in') && row.canTest) return { label: 'Check', kind: 'check' };
  return null;
}

/** The last deep-check answer per agent, kept while the app runs so leaving and reopening the page still shows it. */
const lastChecked = new Map<string, AgentHealth>();

/** The agents, one row each. Shells are not agents and are left out. */
export function useAgentRows(given?: AgentRowsApi): { rows: AgentRow[]; refreshCaps: (agentId: string) => void; recheck: (agentId: string) => Promise<void> } {
  const registry = useAgentRegistry();
  const host = useHost();
  const api = useMemo<AgentRowsApi>(() => given ?? { ...defaultRowsApi, health: agentHealthApiFor(host) }, [given, host]);
  const [health, setHealth] = useState<AgentHealth[]>([]);
  const [checking, setChecking] = useState<string[]>([]);
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
    setChecking((cur) => [...cur, agentId]);
    let fresh: AgentHealth;
    try {
      fresh = await api.health.test(agentId);
    } finally {
      setChecking((cur) => cur.filter((id) => id !== agentId));
    }
    lastChecked.set(agentId, fresh);
    rememberTest(fresh); // the Overview reads the same memory: both say "works" only after a Test
    setHealth((cur) => (cur.some((h) => h.id === agentId) ? cur.map((h) => (h.id === agentId ? fresh : h)) : [...cur, fresh]));
  };

  const rows = registry.agents
    .filter((a) => a.kind !== 'shell')
    .map<AgentRow>((a) => {
      const quick = health.find((x) => x.id === a.id);
      // A deep check made in this window stands in for the quick one; what an older Test said is read by `agentReadiness`.
      const h = !quick || quick.state === 'unchecked' ? (lastChecked.get(a.id) ?? quick) : quick;
      return {
        id: a.id,
        label: a.label,
        icon: a.icon,
        installed: a.installed,
        state: h?.state ?? 'unchecked',
        reason: h?.reason ?? '',
        version: h?.version ?? caps[a.id]?.program_version ?? null,
        loginHint: h?.login_hint ?? null,
        canTest: h?.can_test ?? false,
        caps: caps[a.id] ?? null,
        checking: checking.includes(a.id),
      };
    });
  return { rows, refreshCaps, recheck };
}
