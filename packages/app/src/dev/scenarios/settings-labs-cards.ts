import type { HarnessScenario } from '../types';

// Labs: each area is a card that starts closed; one is opened.
const s: HarnessScenario = {
  name: 'settings-labs-cards',
  route: 'settings',
  settingsTab: 'labs',
  window: { width: 1100, height: 1500 },
  after: async (dom) => {
    await dom.waitFor('.st-labs-area');
    await dom.clickText('.st-labs-area .st-adv-toggle', 'Chat');
    await dom.sleep(300);
  },
};
export default s;
