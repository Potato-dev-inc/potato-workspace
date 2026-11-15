import { MAC_MINI } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// Add a device > Far away: this PC made a pairing link (valid 10 minutes, works once); below it, the box to paste one.
const s: HarnessScenario = {
  name: 'devices-far',
  route: 'settings',
  settingsTab: 'devices',
  window: { width: 1100, height: 1000 },
  devices: { devices: [MAC_MINI] },
  after: async (dom) => {
    await dom.waitFor('[data-testid="add-device"]');
    await dom.click('[data-testid="add-device"]');
    await dom.waitFor('[data-testid="add-tab-far"]');
    await dom.click('[data-testid="add-tab-far"]');
    await dom.waitFor('[data-testid="make-link"]');
    await dom.click('[data-testid="make-link"]');
    await dom.waitFor('[data-testid="the-link"]');
    await dom.sleep(300);
  },
};
export default s;
