import { shelfState } from '../shelf-fixtures';
import { teamPageLend, teamPageState } from '../team-page-fixtures';
import type { HarnessScenario } from '../types';

// The Team page, Shelf tab, dark theme (headless evidence).
const s: HarnessScenario = {
  name: 'team-lend-shelf',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1100, height: 700 },
  team: teamPageState(),
  lend: teamPageLend(),
  shelf: shelfState(),
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-connect"]');
    await dom.click('[data-testid="side-connect"]');
    await dom.click('[data-testid="connect-tab-team"]');
    await dom.waitFor('[data-testid="tab-shelf"]');
    await dom.click('[data-testid="tab-shelf"]');
    await dom.waitFor('[data-testid="shelf-tab"]');
    await dom.sleep(500);
  },
};
export default s;
