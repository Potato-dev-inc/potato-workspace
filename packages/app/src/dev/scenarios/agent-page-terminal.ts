import type { HarnessScenario } from '../types';

// Settings > Agents > OpenCode: an agent page for a terminal-only agent.
const s: HarnessScenario = {
  name: 'agent-page-terminal',
  route: 'settings',
  settingsTab: 'agents',
  window: { width: 1280, height: 900 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="agent-row-claude"]');
    await dom.sleep(400);
    await dom.click('[data-testid="agent-row-opencode"] .ag-open');
    await dom.sleep(900);
  },
};
export default s;
