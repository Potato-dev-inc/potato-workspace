import { fill, lendState } from '../lend-fixtures';
import type { HarnessScenario } from '../types';

// Step 2 after the sign-in worked: the terminal folded away and one calm row says who ("Signed in as ren@example.com");
// Next is the orange button. (The scenario's fake agent signs in at once.)
const s: HarnessScenario = {
  name: 'lend-profile-signin-done',
  route: 'settings',
  settingsTab: 'lend',
  window: { width: 900, height: 900 },
  accounts: [{ id: 'acct-lend', agent_id: 'claude', label: 'Lend Claude', home: 'C:/lend/claude', lend_only: true }],
  lend: lendState({ profiles: [], signins: { 'acct-1': { state: 'signed_in', identity: 'ren@example.com' } } }),
  after: async (dom) => {
    await dom.waitFor('.lend-page');
    await dom.clickText('button', 'New lend profile');
    await dom.waitFor('.lend-sheet');
    fill('input[aria-label="Name"]', 'Work account');
    await dom.clickText('.lend-card', 'Claude');
    await dom.clickText('.lend-actions button', 'Next');
    await dom.waitFor('.lend-signin');
    await dom.clickText('.lend-signin button', 'Sign in');
    await dom.waitFor('.lend-signed');
    await dom.sleep(3500);
  },
};
export default s;
