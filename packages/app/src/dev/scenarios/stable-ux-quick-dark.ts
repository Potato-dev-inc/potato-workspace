import type { HarnessScenario } from '../types';

// Settings > Connect > Phone: quick tunnel, dark theme. `quick` offers "Keep one address"; `linked` shows the stable address with a chip.
const s: HarnessScenario = {
  name: 'stable-ux-quick-dark',
  route: 'settings',
  settingsTab: 'connect',
  tunnel: 'quick',
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
