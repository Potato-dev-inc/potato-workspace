import type { HarnessScenario } from '../types';

// Settings > Agents: the list of agents, with the Add an agent box above it.
const s: HarnessScenario = {
  name: 'agent-page-list',
  route: 'settings',
  settingsTab: 'agents',
  window: { width: 1280, height: 900 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="agent-row-claude"]');
    await dom.sleep(400);
    
    await dom.sleep(900);
  },
};
export default s;
