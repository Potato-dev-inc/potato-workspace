import { fill, lendState } from '../lend-fixtures';
import type { HarnessScenario } from '../types';

// Step 2: "Sign in" was pressed. The sign-in runs in a small terminal INSIDE the sheet (a hidden pane: nothing in the sidebar,
// nothing selected): "Waiting for you to sign in...", Start again, Cancel sign-in. The page behind stays on Settings.
const s: HarnessScenario = {
  name: 'lend-profile-signin-waiting',
  route: 'settings',
  settingsTab: 'lend',
  window: { width: 900, height: 1000 },
  accounts: [{ id: 'acct-lend', agent_id: 'claude', label: 'Lend Claude', home: 'C:/lend/claude', lend_only: true }],
  lend: lendState({ profiles: [] }),
  after: async (dom) => {
    await dom.waitFor('.lend-page');
    await dom.clickText('button', 'New lend profile');
    await dom.waitFor('.lend-sheet');
    fill('input[aria-label="Name"]', 'Work account');
    await dom.clickText('.lend-card', 'Claude');
    await dom.clickText('.lend-actions button', 'Next');
    await dom.waitFor('.lend-signin');
    await dom.clickText('.lend-signin button', 'Sign in');
    await dom.waitFor('.lend-waiting');
    await dom.sleep(800);
  },
};
export default s;
