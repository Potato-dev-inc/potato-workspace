import type { HarnessScenario } from '../types';

// Settings > Agents > Rules for agents: Force yes per agent, fences per project and the starting settings of new agents.
const s: HarnessScenario = {
  name: 'agent-rules-settings-dark',
  route: 'settings',
  theme: 'dark',
  settingsTab: 'agents',
  window: { width: 900, height: 4200 },
  after: async (dom) => {
    await dom.waitFor('.st-adv-toggle');
    await dom.click('.st-adv-toggle');
    await dom.waitFor('[data-testid="agent-rules-panel"]');
    document.querySelector('[data-testid="agent-rules-panel"]')?.scrollIntoView();
    await dom.sleep(500);
  },
};
export default s;
