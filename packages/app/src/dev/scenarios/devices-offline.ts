import { MAC_MINI, MAC_PANES, NODE_MAC } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// The Mac mini's link drops (a pulled cable): its group turns grey, says "offline" and "Last seen", and keeps its rows.
const s: HarnessScenario = {
  name: 'devices-offline',
  route: 'cockpit',
  window: { width: 1280, height: 900 },
  devices: { devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES }, offlineAfterMs: 1500 },
  after: async (dom) => {
    await dom.waitFor(`[data-testid="device-group-${NODE_MAC}"][data-state="offline"]`, 8000);
    await dom.sleep(300);
  },
};
export default s;
