import type { HarnessScenario } from '../types';

// Settings > Agents > Where agents start: the "Offer Work on a copy" switch and the choice for this project.
const s: HarnessScenario = {
  name: 'small112-copyoffer-settings-dark',
  route: 'settings',
  settingsTab: 'agents',
  theme: 'dark',
  window: { width: 1100, height: 900 },
  after: async (dom) => {
    await dom.waitFor('.st-adv-toggle');
    await dom.click('.st-adv-toggle');
    await dom.waitFor('select[aria-label="Work on a copy for this project"]');
    document.querySelector('select[aria-label="Work on a copy for this project"]')?.scrollIntoView({ block: 'center' });
    await dom.sleep(500);
  },
};
export default s;
