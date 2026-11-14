import type { HarnessScenario } from '../types';

// Settings > Phone > Public address with a Stable link that is linked; "Show secret" reveals the secret with Copy.
const s: HarnessScenario = {
  name: 'stable-link-linked',
  route: 'settings',
  settingsTab: 'tunnel',
  tunnel: 'stable',
  window: { width: 1100, height: 1250 },
  after: async (api) => {
    await api.waitFor('section[aria-label="Public address"]');
    await api.sleep(300);
    await api.clickText('button', 'Show secret');
    await api.sleep(400);
  },
};
export default s;
