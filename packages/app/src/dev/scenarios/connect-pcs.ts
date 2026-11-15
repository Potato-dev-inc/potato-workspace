import { MAC_MINI, WORK_LAPTOP } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// Connect > My PCs: the paired PCs first (one online, one asleep), then Add another PC.
const s: HarnessScenario = {
  name: 'connect-pcs',
  route: 'cockpit',
  window: { width: 1280, height: 900 },
  devices: { devices: [{ ...MAC_MINI, lets_run: true }, WORK_LAPTOP] },
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-connect"]');
    await dom.click('[data-testid="side-connect"]');
    await dom.click('[data-testid="connect-tab-pcs"]');
    await dom.waitFor('.dev-list');
    await dom.sleep(500);
  },
};
export default s;
