import type { HarnessScenario } from '../types';

// Checkpoint-2 fixes evidence: agents, dark theme, 900 px wide.
const s: HarnessScenario = {
  name: 'fcp2-agents-dark-900',
  route: 'settings',
  settingsTab: 'agents',
  theme: 'dark',
  window: { width: 900, height: 820 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="agent-row-claude"]'); await dom.sleep(700);
  },
};
export default s;
