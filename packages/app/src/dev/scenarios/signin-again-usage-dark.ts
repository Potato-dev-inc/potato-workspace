import type { HarnessScenario } from '../types';
import { exampleUsage } from '../usage-fixtures';

// "Sign in again" from the Usage card's expired row: the small sign-in sheet over the cockpit, the sign-in running in a
// hidden pane (nothing new in the sidebar).
const s: HarnessScenario = {
  name: 'signin-again-usage-dark',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1100, height: 760 },
  usage: exampleUsage(),
  after: async (dom) => {
    await dom.sleep(600);
    await dom.click('[data-testid="usage-strip"]');
    await dom.sleep(300);
    await dom.click('.ck-usage-pop-row.is-expired [data-testid="usage-sign-in-again"]');
    await dom.sleep(300);
    await dom.clickText('button', 'Sign in');
    await dom.sleep(500);
  },
};
export default s;
