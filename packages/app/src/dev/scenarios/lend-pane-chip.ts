import { PANE_CLAUDE } from '../fixtures';
import { GRANT_IN_PROBLEM, lendState } from '../lend-fixtures';
import type { HarnessScenario } from '../types';

// A pane running on a borrowed sign-in: the time-left chip ("Leo's Claude · 1h 59m") opened. Its details say what was
// used and show the lender's problem ("The lender's sign-in expired. Ask them to sign in again.").
const s: HarnessScenario = {
  name: 'lend-pane-chip',
  route: 'cockpit',
  select: PANE_CLAUDE,
  lend: lendState({ grants: [GRANT_IN_PROBLEM] }),
  after: async (dom) => {
    await dom.waitFor('[data-testid="lend-chip"]');
    await dom.click('[data-testid="lend-chip"]');
    await dom.waitFor('.lend-pop');
    await dom.sleep(300);
  },
};
export default s;
