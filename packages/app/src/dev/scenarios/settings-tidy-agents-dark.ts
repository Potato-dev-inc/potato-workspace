import type { HarnessScenario } from '../types';

// Settings > Agents: warm agents with - and + steppers (a high number shows the memory note).
const s: HarnessScenario = {
  name: 'settings-tidy-agents-dark',
  route: 'settings',
  settingsTab: 'agents',
  theme: 'dark',
  window: { width: 1280, height: 3600 },
  after: async (dom) => {
    await dom.waitFor('.st-adv-toggle');
    await dom.click('.st-adv-toggle');
    await dom.waitFor('[data-testid="preload-providers"]');
    await dom.sleep(400);
  },
};
export default s;
