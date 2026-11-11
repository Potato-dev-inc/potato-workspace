import { lendState } from '../lend-fixtures';
import type { HarnessScenario } from '../types';

// The profile editor: "Add a lend sign-in" or "Paste an API key", the main sign-in shown but off ("Coming later"),
// Codex as "coming soon", the optional limits.
const s: HarnessScenario = {
  name: 'lend-profile-editor',
  route: 'settings',
  settingsTab: 'lend',
  window: { width: 1100, height: 1500 },
  accounts: [{ id: 'acct-lend', agent_id: 'claude', label: 'Lend login', home: 'C:\lend\claude', lend_only: true }],
  lend: lendState({ profiles: [] }),
  after: async (dom) => {
    await dom.waitFor('.lend-page');
    await dom.clickText('button', 'New profile');
    await dom.waitFor('.lend-editor');
    await dom.sleep(300);
  },
};
export default s;
