import type { HarnessScenario } from '../types';
import { EXAMPLE_ACCOUNTS } from '../fixtures';
import { LAST_SIGN_IN_KEY } from '../../lib/accounts';

// The "+" menu when Claude was last started with its second sign-in: the row names it and has a small Change.
const s: HarnessScenario = {
  name: 'cockpit-accounts-remembered',
  route: 'cockpit',
  accounts: EXAMPLE_ACCOUNTS,
  storage: { [LAST_SIGN_IN_KEY]: JSON.stringify({ claude: 'acc_home' }) },
  after: async (dom) => {
    await dom.click('button[aria-label="New agent"]');
    await dom.sleep(800);
  },
};
export default s;
