import type { HarnessScenario } from '../types';

// Settings > Connect > Phone: linked tunnel, dark theme. `quick` offers "Keep one address"; `linked` shows the stable address with a chip.
const s: HarnessScenario = {
  name: 'stable-ux-linked-dark',
  route: 'settings',
  settingsTab: 'connect',
  tunnel: 'stable',
  theme: 'dark',
  window: { width: 1100, height: 900 },
  after: async (dom) => {
    await dom.waitFor('.st-closed-group[data-group="Phone"] .st-adv-toggle');
    await dom.clickText('.st-closed-group[data-group="Phone"] .st-adv-toggle', 'Phone');
    await dom.waitFor('[data-testid="pairing-origin"]');
    await dom.sleep(700);
  },
};
export default s;
