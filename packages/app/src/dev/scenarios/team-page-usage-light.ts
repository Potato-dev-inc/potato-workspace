import { teamPageLend, teamPageState } from '../team-page-fixtures';
import type { HarnessScenario } from '../types';

// The Team page, usage tab, light theme (headless evidence).
const s: HarnessScenario = {
  name: 'team-page-usage-light',
  route: 'cockpit',
  theme: 'light',
  window: { width: 1100, height: 800 },
  team: teamPageState(),
  lend: teamPageLend(),
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-team"]');
    await dom.click('[data-testid="side-team"]');
    await dom.waitFor('[data-testid="tab-usage"]');
    await dom.click('[data-testid="tab-usage"]');
    await dom.sleep(500);
  },
};
export default s;
