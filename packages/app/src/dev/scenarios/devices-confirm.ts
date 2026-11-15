import { MAC_MINI } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// Both people confirm: "Desk-PC" wants to pair, the same code on both screens, Allow or No. Pairing finishes only when both say yes.
const s: HarnessScenario = {
  name: 'devices-confirm',
  route: 'settings',
  settingsTab: 'devices',
  window: { width: 1100, height: 900 },
  devices: { devices: [MAC_MINI], pending: { id: 7, role: 'host', name: 'Desk-PC', code: '4F7Q-9K2M', expires_at: Date.now() + 120_000 } },
  after: async (dom) => {
    await dom.waitFor('[data-testid="pair-confirm"]');
    await dom.sleep(300);
  },
};
export default s;
