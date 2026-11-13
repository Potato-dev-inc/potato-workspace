// Fake sources for the Overview cards, for tests: every card answers at once with plain, healthy data unless overridden.
import type { OverviewSources } from './Overview';

export function fakeOverviewSources(over: Partial<OverviewSources> = {}): OverviewSources {
  return {
    checks: async () => [
      { id: 'agent-claude', status: 'ok', sentence: 'Claude is signed in', fix: null },
      { id: 'agent-codex', status: 'ok', sentence: 'Codex is signed in', fix: null },
    ],
    setupDeps: { agentHealth: async () => [], addons: async () => ({ addons: [] }) as never },
    accounts: async () => ({
      agents: [
        { agent_id: 'claude', login_hint: '', home_env: '' },
        { agent_id: 'codex', login_hint: '', home_env: '' },
      ],
      accounts: [
        { id: 'a1', agent_id: 'claude', label: 'Personal', home: '' },
        { id: 'a2', agent_id: 'codex', label: 'Personal', home: '' },
      ],
    }),
    phones: async () => 1,
    version: async () => '1.0.19',
    update: async () => null,
    helpers: async () => ({ mode: 'always_show', keepOpen: true, connected: true }),
    actions: { signIn: () => undefined, installAddon: async () => undefined },
    ...over,
  };
}
