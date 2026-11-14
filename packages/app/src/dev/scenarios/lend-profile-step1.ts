import { fill, lendState } from '../lend-fixtures';
import type { HarnessScenario } from '../types';

// Settings > Lend > New lend profile, step 1 of 4: the name (with the live "They will see" line) and ONE agent, with small tags.
const s: HarnessScenario = {
  name: 'lend-profile-step1',
  route: 'settings',
  settingsTab: 'lend',
  window: { width: 900, height: 900 },
  accounts: [{ id: 'acct-lend', agent_id: 'claude', label: 'Lend Claude', home: 'C:/lend/claude', lend_only: true }],
  lend: lendState({ profiles: [] }),
  after: async (dom) => {
    await dom.waitFor('.lend-page');
    await dom.clickText('button', 'New lend profile');
    await dom.waitFor('.lend-sheet');
    fill('input[aria-label="Name"]', 'Work account');
    await dom.clickText('.lend-card', 'Claude');
    await dom.sleep(400);
  },
};
export default s;
