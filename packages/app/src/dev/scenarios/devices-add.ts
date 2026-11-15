import { MAC_MINI, WORK_LAPTOP } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// Settings > Devices > Add a device: the sheet with its four ways in. "With a code" is the one that works now; far away and over
// SSH are marked as coming. Behind it: the paired devices (one live, one asleep) and "How far-away devices connect".
const s: HarnessScenario = {
  name: 'devices-add',
  route: 'settings',
  settingsTab: 'devices',
  window: { width: 1100, height: 1000 },
  devices: { devices: [MAC_MINI, WORK_LAPTOP] },
  after: async (dom) => {
    await dom.waitFor('[data-testid="devices-page"]');
    await dom.click('[data-testid="add-device"]');
    await dom.waitFor('[data-testid="add-device-sheet"]');
    await dom.sleep(300);
  },
};
export default s;
