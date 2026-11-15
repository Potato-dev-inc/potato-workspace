import { MAC_MINI, MAC_PANES, NODE_MAC } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// The far side: the Mac mini is using this PC right now. A thin banner says so, with Disconnect.
const s: HarnessScenario = {
  name: 'devices-connected',
  route: 'cockpit',
  window: { width: 1280, height: 900 },
  devices: { devices: [{ ...MAC_MINI, lets_run: true, level: 'full', connected: true }], panes: { [NODE_MAC]: MAC_PANES } },
  after: async (dom) => {
    await dom.waitFor('[data-testid="connected-banner"]');
    await dom.sleep(300);
  },
};
export default s;
