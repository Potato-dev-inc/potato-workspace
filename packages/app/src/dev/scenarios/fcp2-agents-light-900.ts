import type { HarnessScenario } from '../types';

// Checkpoint-2 fixes evidence: agents, light theme, 900 px wide.
const s: HarnessScenario = {
  name: 'fcp2-agents-light-900',
  route: 'settings',
  settingsTab: 'agents',
  theme: 'light',
  window: { width: 900, height: 820 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="agent-row-claude"]'); await dom.sleep(700);
  },
};
export default s;
