import type { HarnessScenario } from '../types';

// "Set up stable link" in Settings > Connect: one button, steps with status, then one plain sentence and "Let Claude fix it" after 3 tries.
const s: HarnessScenario = {
  name: 'worker-update-failed-light',
  route: 'settings',
  settingsTab: 'connect',
  theme: 'light',
  tunnel: 'quick',
  window: { width: 900, height: 1100 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="pairing-panel"]');
    await dom.click('.st-closed-group[data-group="Phone"] .st-adv-toggle');
    await dom.sleep(400);
    await dom.click('[data-testid="keep-one-address"]');
    await dom.waitFor('[data-testid="worker-update-go"]');
    await dom.click('[data-testid="worker-update-go"]');
    await dom.waitFor('[data-testid="worker-update-failed"]', 15000);
    await dom.sleep(400);
  },
};
export default s;
