import { MAC_MINI, MAC_PANES, NODE_MAC, WORK_LAPTOP } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// New agent > Where: This PC, the Mac mini, and the work laptop that is asleep (listed, not pickable), then "Add a device…".
const s: HarnessScenario = {
  name: 'devices-where',
  route: 'cockpit',
  window: { width: 1280, height: 900 },
  devices: { devices: [MAC_MINI, WORK_LAPTOP], panes: { [NODE_MAC]: MAC_PANES } },
  after: async (dom) => {
    await dom.waitFor('button[aria-label="Quick start menu"]');
    await dom.click('button[aria-label="Quick start menu"]');
    await dom.waitFor('[data-testid="where-pill"]');
    await dom.click('[data-testid="where-pill"]');
    await dom.waitFor('.dev-where-menu');
    await dom.sleep(300);
  },
};
export default s;
