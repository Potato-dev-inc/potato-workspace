import { MAC_MINI, MAC_PANES, NODE_MAC, WORK_LAPTOP } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// After picking the Mac mini there hands over to the full New agent page.
const s: HarnessScenario = {
  name: 'devices-newagent-sidebar-pick-dark',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1280, height: 800 },
  devices: { devices: [MAC_MINI, WORK_LAPTOP], panes: { [NODE_MAC]: MAC_PANES } },
  after: async (dom) => {
    await dom.sleep(700);
    await dom.click('button[aria-label="Quick start menu"]');
    await dom.waitFor('[data-testid="where-pill"]');
    await dom.click('[data-testid="where-pill"]');
    await dom.waitFor('.dev-where-menu');
    await dom.click(`[data-testid="where-${NODE_MAC}"]`);
    await dom.waitFor('[data-testid="na-on-device"]');
    await dom.waitFor('[data-testid="na-agent"]');
    await dom.sleep(400);
  },
};
export default s;
