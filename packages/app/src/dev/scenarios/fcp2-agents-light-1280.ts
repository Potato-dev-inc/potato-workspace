import type { HarnessScenario } from '../types';

// Checkpoint-2 fixes evidence: agents, light theme, 1280 px wide.
const s: HarnessScenario = {
  name: 'fcp2-agents-light-1280',
  route: 'settings',
  settingsTab: 'agents',
  theme: 'light',
  window: { width: 1280, height: 820 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="agent-row-claude"]'); await dom.sleep(700);
  },
};
export default s;
