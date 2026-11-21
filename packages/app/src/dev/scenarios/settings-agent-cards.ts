import type { HarnessScenario } from '../types';

// Settings > Agents: every agent has its own larger card: mark and name, the sign-in it uses (with the account
// label), usage when the app already has it, and the buttons Sign in / Sign out.
const s: HarnessScenario = {
  name: 'settings-agent-cards',
  route: 'settings',
  settingsTab: 'agents',
  window: { width: 1100, height: 1000 },
  accounts: [
    {
      id: 'acc_work',
      agent_id: 'claude',
      label: 'Work (Max)',
      home: 'C:\\Users\\dev\\AppData\\Roaming\\com.potatodev.workspace\\accounts\\acc_work',
      login_state: 'signed_in',
    },
    {
      id: 'acc_codex',
      agent_id: 'codex',
      label: 'Team seat',
      home: 'C:\\Users\\dev\\AppData\\Roaming\\com.potatodev.workspace\\accounts\\acc_codex',
      login_state: 'signed_out',
    },
  ],
  usage: {
    rows: [
      {
        agent_id: 'claude',
        label: 'Claude',
        account_id: 'acc_work',
        account_label: 'Work (Max)',
        state: 'ok',
        reason: null,
        windows: [{ name: 'Weekly', used_percent: 42, resets_at_ms: Date.now() + 2 * 86_400_000, reset_since: false }],
        plan: 'Max',
        observed_at_ms: Date.now() - 60_000,
        limited_until_ms: null,
        page: null,
      },
    ],
    refreshed_at_ms: Date.now(),
  },
  after: async (dom) => {
    await dom.waitFor('.ag-card');
    await dom.sleep(600);
  },
};
export default s;
