import { fill, lendState } from '../lend-fixtures';
import type { HarnessScenario } from '../types';

// Step 4 of 4, "Ready to lend": the summary card with a Change on every line, and where the other PC asks for it.
const s: HarnessScenario = {
  name: 'lend-profile-review',
  route: 'settings',
  settingsTab: 'lend',
  window: { width: 900, height: 900 },
  accounts: [{ id: 'acct-lend', agent_id: 'claude', label: 'Lend Claude', home: 'C:/lend/claude', lend_only: true }],
  lend: lendState({ profiles: [], signins: { 'acct-lend': { state: 'signed_in', identity: 'ren@example.com' } } }),
  after: async (dom) => {
    await dom.waitFor('.lend-page');
    await dom.clickText('button', 'New lend profile');
    await dom.waitFor('.lend-sheet');
    fill('input[aria-label="Name"]', 'Work account');
    await dom.clickText('.lend-card', 'Claude');
    await dom.clickText('.lend-actions button', 'Next');
    await dom.waitFor('.lend-signin');
    await dom.clickText('.lend-card', 'Use a sign-in I already added');
    const pick = document.querySelector<HTMLSelectElement>('select[aria-label="Lend sign-in"]');
    if (pick) {
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      set?.call(pick, 'acct-lend');
      pick.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await dom.sleep(500);
    await dom.clickText('.lend-actions button', 'Next');
    await dom.sleep(200);
    await dom.clickText('.lend-actions button', 'Next');
    await dom.waitFor('.lend-summary');
    await dom.sleep(600);
  },
};
export default s;
