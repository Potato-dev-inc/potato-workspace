import type { HarnessScenario } from '../types';

// The "Keep one address" sheet open on the Connect page, dark theme.
const s: HarnessScenario = {
  name: 'stable-ux-sheet-dark',
  route: 'settings',
  settingsTab: 'connect',
  tunnel: 'quick',
  theme: 'dark',
  window: { width: 1100, height: 1000 },
  after: async (dom) => {
    await dom.waitFor('.st-closed-group[data-group="Phone"] .st-adv-toggle');
    await dom.clickText('.st-closed-group[data-group="Phone"] .st-adv-toggle', 'Phone');
    await dom.waitFor('[data-testid="keep-one-address"]');
    await dom.sleep(500);
    await dom.clickText('button', 'Keep one address');
    await dom.waitFor('[data-testid="stable-sheet"]');
    await dom.sleep(400);
  },
};
export default s;
