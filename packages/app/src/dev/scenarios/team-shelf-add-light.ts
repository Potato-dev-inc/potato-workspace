import { shelfState } from '../shelf-fixtures';
import { teamPageLend, teamPageState } from '../team-page-fixtures';
import type { HarnessScenario } from '../types';

// The Team page, Shelf tab, Add sheet for a tool that needs "I trust this", light theme (headless evidence).
const s: HarnessScenario = {
  name: 'team-shelf-add-light',
  route: 'cockpit',
  theme: 'light',
  window: { width: 1100, height: 1300 },
  team: teamPageState(),
  lend: teamPageLend(),
  shelf: shelfState(),
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-team"]');
    await dom.click('[data-testid="side-team"]');
    await dom.waitFor('[data-testid="tab-shelf"]');
    await dom.click('[data-testid="tab-shelf"]');
    await dom.waitFor('[data-testid="shelf-suggested-c-linear"] .ck-btn--primary');
    await dom.click('[data-testid="shelf-suggested-c-linear"] .ck-btn--primary');
    await dom.waitFor('[data-testid="shelf-risk-shown"]');
    await dom.sleep(500);
  },
};
export default s;
