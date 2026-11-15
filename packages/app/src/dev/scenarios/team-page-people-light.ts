import { teamPageLend, teamPageState } from '../team-page-fixtures';
import type { HarnessScenario } from '../types';

// The Team page, people tab, light theme (headless evidence).
const s: HarnessScenario = {
  name: 'team-page-people-light',
  route: 'cockpit',
  theme: 'light',
  window: { width: 1100, height: 800 },
  team: teamPageState(),
  lend: teamPageLend(),
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-connect"]');
    await dom.click('[data-testid="side-connect"]');
    await dom.click('[data-testid="connect-tab-team"]');
    await dom.waitFor('[data-testid="tab-people"]');
    await dom.click('[data-testid="tab-people"]');
    await dom.sleep(500);
  },
};
export default s;
