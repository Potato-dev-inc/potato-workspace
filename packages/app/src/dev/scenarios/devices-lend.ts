import { MAC_MINI, NODE_MAC, WORK_LAPTOP } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// One device's page with the lend switch on: "Borrow my agent sign-ins" (this PC lets that device ask to borrow a sign-in; the
// sign-in never leaves it), beside "Run agents and terminals here" and "Agents may send work to this device".
const s: HarnessScenario = {
  name: 'devices-lend',
  route: 'settings',
  settingsTab: 'devices',
  window: { width: 1100, height: 1000 },
  devices: {
    devices: [{ ...MAC_MINI, lets_run: true, level: 'full', lets_lend: true }, { ...WORK_LAPTOP }],
  },
  after: async (dom) => {
    await dom.waitFor(`[data-testid="device-${NODE_MAC}"]`);
    await dom.click(`[data-testid="device-${NODE_MAC}"]`);
    await dom.waitFor('[data-testid="perm-lend"]');
    await dom.sleep(300);
  },
};
export default s;
