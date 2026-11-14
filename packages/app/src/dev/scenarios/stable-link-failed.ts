import type { HarnessScenario } from '../types';

// Settings > Phone > Public address with a Stable link the Worker refused (the secret does not match).
const s: HarnessScenario = {
  name: 'stable-link-failed',
  route: 'settings',
  settingsTab: 'tunnel',
  tunnel: 'stable-failed',
  window: { width: 1100, height: 1250 },
  after: async (api) => {
    await api.waitFor('section[aria-label="Public address"]');
    await api.sleep(400);
  },
};
export default s;
