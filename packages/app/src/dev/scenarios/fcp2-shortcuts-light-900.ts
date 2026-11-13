import type { HarnessScenario } from '../types';

// Checkpoint-2 fixes evidence: shortcuts, light theme, 900 px wide.
const s: HarnessScenario = {
  name: 'fcp2-shortcuts-light-900',
  route: 'settings',
  settingsTab: 'shortcuts',
  theme: 'light',
  window: { width: 900, height: 820 },
  after: async (dom) => {
    await dom.waitFor('.st-keycap'); await dom.sleep(600);
  },
};
export default s;
