import { LIMITS } from '../project-budget-fixtures';
import type { HarnessScenario } from '../types';

// Settings > Agents > Limits: the budget of this project and the model suggestion switch.
const s: HarnessScenario = {
  name: 'project-budget-settings-light',
  route: 'settings',
  theme: 'light',
  settingsTab: 'agents',
  window: { width: 900, height: 2600 },
  projectBudget: { limits: LIMITS },
  after: async (dom) => {
    await dom.waitFor('.st-adv-toggle');
    await dom.click('.st-adv-toggle');
    await dom.waitFor('[data-row="project-budget"]');
    document.querySelector('[data-row="project-budget"]')?.scrollIntoView({ block: 'center' });
    await dom.sleep(500);
  },
};
export default s;
