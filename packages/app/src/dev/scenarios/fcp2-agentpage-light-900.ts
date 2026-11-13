import type { HarnessScenario } from '../types';

// Checkpoint-2 fixes evidence: agentpage, light theme, 900 px wide.
const s: HarnessScenario = {
  name: 'fcp2-agentpage-light-900',
  route: 'settings',
  settingsTab: 'agents',
  theme: 'light',
  window: { width: 900, height: 820 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="agent-row-claude"]'); await dom.sleep(400); await dom.click('[data-testid="agent-row-claude"] .ag-open'); await dom.sleep(900);
  },
};
export default s;
