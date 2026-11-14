import { fill, lendState } from '../lend-fixtures';
import type { HarnessScenario } from '../types';

// The sheet was closed on step 2: Settings > Lend keeps the draft as a row, "Finish setting up "Work account" · Step 2 of 4",
// with Continue and Discard. Nothing was lost and no pane was opened.
const s: HarnessScenario = {
  name: 'lend-draft-row',
  route: 'settings',
  settingsTab: 'lend',
  window: { width: 900, height: 700 },
  accounts: [{ id: 'acct-lend', agent_id: 'claude', label: 'Lend Claude', home: 'C:/lend/claude', lend_only: true }],
  lend: lendState({}),
  after: async (dom) => {
    await dom.waitFor('.lend-page');
    await dom.clickText('button', 'New lend profile');
    await dom.waitFor('.lend-sheet');
    fill('input[aria-label="Name"]', 'Work account');
    await dom.clickText('.lend-card', 'Claude');
    await dom.clickText('.lend-actions button', 'Next');
    await dom.waitFor('.lend-signin');
    await dom.click('button[aria-label="Close"]');
    await dom.waitFor('[data-testid="lend-draft-row"]');
    await dom.sleep(300);
  },
};
export default s;
