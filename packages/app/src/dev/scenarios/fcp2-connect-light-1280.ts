import type { HarnessScenario } from '../types';

// Checkpoint-2 fixes evidence: connect, light theme, 1280 px wide.
const s: HarnessScenario = {
  name: 'fcp2-connect-light-1280',
  route: 'settings',
  settingsTab: 'connect',
  theme: 'light',
  window: { width: 1280, height: 820 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="pairing-panel"]'); await dom.sleep(700);
  },
};
export default s;
