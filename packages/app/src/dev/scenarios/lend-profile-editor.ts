import { lendState } from '../lend-fixtures';
import type { HarnessScenario } from '../types';

// Editing a saved profile: Edit opens the same four-step sheet on its last step, every line with Change, the sign-in
// line live ("Signed in as ren@example.com").
const s: HarnessScenario = {
  name: 'lend-profile-editor',
  route: 'settings',
  settingsTab: 'lend',
  window: { width: 900, height: 900 },
  accounts: [{ id: 'acct-lend', agent_id: 'claude', label: 'Lend Claude', home: 'C:/lend/claude', lend_only: true }],
  lend: lendState({ signins: { 'acct-lend': { state: 'signed_in', identity: 'ren@example.com' } } }),
  after: async (dom) => {
    await dom.waitFor('.lend-page');
    await dom.clickText('button', 'Edit');
    await dom.waitFor('.lend-summary');
    await dom.sleep(500);
  },
};
export default s;
