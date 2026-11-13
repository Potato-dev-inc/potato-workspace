import type { HarnessScenario } from '../types';

// Checkpoint-2 fixes evidence: overview, dark theme, 1280 px wide.
const s: HarnessScenario = {
  name: 'fcp2-overview-dark-1280',
  route: 'settings',
  settingsTab: 'overview',
  theme: 'dark',
  window: { width: 1280, height: 820 },
  after: async (dom) => {
    await dom.waitFor('.st-cards'); await dom.sleep(900);
  },
};
export default s;
