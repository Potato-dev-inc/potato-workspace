import { MAC_MINI } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// Settings > Devices: the paired devices, how far-away devices connect (My own route, not set up yet), and the Phones section, so
// one page answers "what can reach this PC".
const s: HarnessScenario = {
  name: 'devices-phones',
  route: 'settings',
  settingsTab: 'devices',
  window: { width: 1100, height: 1500 },
  devices: { devices: [MAC_MINI], route_pref: 'own', own_route_ready: false },
  after: async (dom) => {
    await dom.waitFor('[data-testid="phones-section"] .st-device');
    await dom.sleep(300);
  },
};
export default s;
