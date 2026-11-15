import { MAC_MINI, NODE_MAC } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// One device's page: it may run agents here, its own route (My own route only), the web-address switch, and Device activity
// (what it did here, and what this PC did there), newest first.
const now = Math.floor(Date.now() / 1000);
const s: HarnessScenario = {
  name: 'devices-page',
  route: 'settings',
  settingsTab: 'devices',
  window: { width: 1100, height: 1100 },
  devices: {
    devices: [{ ...MAC_MINI, lets_run: true, level: 'watch', route_override: 'own', web_ready: false, lets_web: true }],
    activity: [
      { at: now - 120, node: NODE_MAC, name: 'Mac mini', dir: 'in', kind: 'started' },
      { at: now - 300, node: NODE_MAC, name: 'Mac mini', dir: 'in', kind: 'answered' },
      { at: now - 900, node: NODE_MAC, name: 'Mac mini', dir: 'out', kind: 'started' },
      { at: now - 960, node: NODE_MAC, name: 'Mac mini', dir: 'out', kind: 'connected' },
      { at: now - 4000, node: NODE_MAC, name: 'Mac mini', dir: 'in', kind: 'refused' },
    ],
  },
  after: async (dom) => {
    await dom.waitFor(`[data-testid="device-${NODE_MAC}"]`);
    await dom.click(`[data-testid="device-${NODE_MAC}"]`);
    await dom.waitFor('[data-testid="device-activity"]');
    await dom.sleep(300);
  },
};
export default s;
