import type { HarnessScenario } from '../types';

// Settings > Agents: the agent list stays open; the other groups are cards that start closed. One card is opened.
const s: HarnessScenario = {
  name: 'settings-agents-cards',
  route: 'settings',
  settingsTab: 'agents',
  window: { width: 1100, height: 1000 },
  after: async (dom) => {
    await dom.waitFor('.st-closed-group');
    await dom.clickText('.st-closed-group .st-adv-toggle', 'Moving work');
    await dom.sleep(300);
  },
};
export default s;
