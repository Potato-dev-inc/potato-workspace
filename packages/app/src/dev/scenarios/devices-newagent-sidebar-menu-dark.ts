import { MAC_MINI, MAC_PANES, NODE_MAC, WORK_LAPTOP } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// The sidebar's quick-start menu with the Where pill open (dark): picking the Mac mini there hands over to the full New agent page.
const s: HarnessScenario = {
  name: 'devices-newagent-sidebar-menu-dark',
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
    await dom.sleep(300);
  },
};
export default s;
