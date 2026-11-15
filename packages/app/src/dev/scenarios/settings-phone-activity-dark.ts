import type { HarnessScenario } from '../types';

// Settings > Phone > "Phone and remote activity": a time, the phone's name and a kind per line. Never a prompt.
const NOW = 1_763_200_000;
const s: HarnessScenario = {
  name: 'settings-phone-activity-dark',
  route: 'settings',
  theme: 'dark',
  settingsTab: 'phone',
  window: { width: 1440, height: 1650 },
  phoneActivity: [
    { at: NOW + 600, node: 'p1', name: 'Pixel 8', dir: 'in', kind: 'stopped' },
    { at: NOW + 420, node: 'p1', name: 'Pixel 8', dir: 'in', kind: 'answered' },
    { at: NOW + 300, node: 'p1', name: 'Pixel 8', dir: 'in', kind: 'messaged' },
    { at: NOW + 120, node: 'p2', name: 'iPhone', dir: 'in', kind: 'started' },
    { at: NOW + 60, node: 'p2', name: 'iPhone', dir: 'in', kind: 'connected' },
  ],
  after: async (api) => {
    await api.waitFor('[data-testid="phone-activity"]');
    await api.sleep(500);
    document.querySelector('[data-testid="phone-activity"]')?.scrollIntoView({ block: 'center' });
    await api.sleep(300);
  },
};
export default s;
