import { MAC_MINI, WORK_LAPTOP } from '../devices-fixtures';
import { teamPageLend, teamPageState } from '../team-page-fixtures';
import type { HarnessScenario } from '../types';

// The Team page, Usage tab, with a paired Mac mini that lets me borrow. Evidence for "Request usage is clickable and the page scrolls".
const s: HarnessScenario = {
  name: 'team-lend-clicks',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1100, height: 700 },
  team: teamPageState(),
  lend: teamPageLend(),
  devices: { devices: [{ ...MAC_MINI, lets_lend: true }, { ...WORK_LAPTOP, lets_lend: false }] },
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-connect"]');
    await dom.click('[data-testid="side-connect"]');
    await dom.click('[data-testid="connect-tab-team"]');
    await dom.waitFor('[data-testid="tab-usage"]');
    await dom.click('[data-testid="tab-usage"]');
    await dom.sleep(500);
  },
};
export default s;
