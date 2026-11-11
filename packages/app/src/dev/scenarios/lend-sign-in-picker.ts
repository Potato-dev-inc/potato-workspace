import { GRANT_IN, GRANT_IN_PANE, lendState } from '../lend-fixtures';
import type { HarnessScenario } from '../types';

// The New agent menu, sign-in step for Claude: my own login next to the lent ones, each with its time left
// ("Leo's PC (lent) · 1h 59m left"). There is no separate Borrowed group.
const s: HarnessScenario = {
  name: 'lend-sign-in-picker',
  route: 'cockpit',
  accounts: [{ id: 'acct-work', agent_id: 'claude', label: 'Work', home: 'C:\work\claude' }],
  lend: lendState({ grants: [GRANT_IN, { ...GRANT_IN_PANE, pane_ids: [] }] }),
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-new-agent-menu"]');
    await dom.click('[data-testid="side-new-agent-menu"]');
    await dom.waitFor('[role="menu"]');
    await dom.sleep(600);
    await dom.clickText('[role="menuitem"]', 'Claude');
    await dom.waitFor('.ck-menu-cap');
    await dom.sleep(400);
  },
};
export default s;
