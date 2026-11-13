import type { HarnessScenario } from '../types';

// Checkpoint-2 fixes evidence: overview, light theme, 900 px wide.
const s: HarnessScenario = {
  name: 'fcp2-overview-light-900',
  route: 'settings',
  settingsTab: 'overview',
  theme: 'light',
  window: { width: 900, height: 820 },
  after: async (dom) => {
    await dom.waitFor('.st-cards'); await dom.sleep(900);
  },
};
export default s;
