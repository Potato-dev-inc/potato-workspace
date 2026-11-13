import type { HarnessScenario } from '../types';

// Checkpoint-2 fixes evidence: advanced, dark theme, 1280 px wide.
const s: HarnessScenario = {
  name: 'fcp2-advanced-dark-1280',
  route: 'settings',
  settingsTab: 'advanced',
  theme: 'dark',
  window: { width: 1280, height: 820 },
  after: async (dom) => {
    await dom.waitFor('.st-closed-group'); await dom.sleep(600);
  },
};
export default s;
