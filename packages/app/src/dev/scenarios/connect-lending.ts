import { GRANT_IN, GRANT_OUT, KEY_PROFILE, MY_PROFILE, TEAM_PROFILE, lendState } from '../lend-fixtures';
import type { HarnessScenario } from '../types';

// Connect > Lending: what is lent and borrowed, Ask to borrow, then profiles and active lends.
const s: HarnessScenario = {
  name: 'connect-lending',
  route: 'cockpit',
  window: { width: 1280, height: 900 },
  accounts: [{ id: 'acct-lend', agent_id: 'claude', label: 'Lend login', home: 'C:/lend/claude', lend_only: true }],
  lend: lendState({ profiles: [MY_PROFILE, TEAM_PROFILE, KEY_PROFILE], grants: [GRANT_OUT, GRANT_IN] }),
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-connect"]');
    await dom.click('[data-testid="side-connect"]');
    await dom.click('[data-testid="connect-tab-lending"]');
    await dom.waitFor('.lend-page');
    await dom.sleep(500);
  },
};
export default s;
