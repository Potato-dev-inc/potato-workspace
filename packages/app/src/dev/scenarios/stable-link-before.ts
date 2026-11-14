import type { HarnessScenario } from '../types';

// Settings > Phone > Public address as it was before the Stable link choice (a named tunnel), for comparison.
const s: HarnessScenario = {
  name: 'stable-link-before',
  route: 'settings',
  settingsTab: 'tunnel',
  window: { width: 1100, height: 1250 },
  after: async (api) => {
    await api.waitFor('section[aria-label="Public address"]');
    await api.sleep(400);
  },
};
export default s;
