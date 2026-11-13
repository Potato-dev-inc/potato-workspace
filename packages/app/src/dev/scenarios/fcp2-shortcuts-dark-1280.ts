import type { HarnessScenario } from '../types';

// Checkpoint-2 fixes evidence: shortcuts, dark theme, 1280 px wide.
const s: HarnessScenario = {
  name: 'fcp2-shortcuts-dark-1280',
  route: 'settings',
  settingsTab: 'shortcuts',
  theme: 'dark',
  window: { width: 1280, height: 820 },
  after: async (dom) => {
    await dom.waitFor('.st-keycap'); await dom.sleep(600);
  },
};
export default s;
