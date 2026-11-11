import { GRANT_IN, GRANT_IN_PROBLEM, GRANT_OUT, KEY_PROFILE, MY_PROFILE, TEAM_PROFILE, lendState } from '../lend-fixtures';
import type { HarnessScenario } from '../types';

// Settings > Lend: profiles with limits, active lends with usage and the lender's sign-in problem. No .pm parts.
const s: HarnessScenario = {
  name: 'lend-page',
  route: 'settings',
  settingsTab: 'lend',
  window: { width: 1100, height: 1100 },
  accounts: [{ id: 'acct-lend', agent_id: 'claude', label: 'Lend login', home: 'C:\lend\claude', lend_only: true }],
  lend: lendState({ profiles: [MY_PROFILE, TEAM_PROFILE, KEY_PROFILE], grants: [GRANT_OUT, GRANT_IN, GRANT_IN_PROBLEM] }),
  after: async (dom) => {
    await dom.waitFor('.lend-page');
    await dom.sleep(300);
  },
};
export default s;
