import type { HarnessScenario } from '../types';

// Settings > General > Appearance: the "Mode switch animation" row (Domino by default) with its Preview button.
const s: HarnessScenario = {
  name: 'settings-mode-switch',
  route: 'settings',
  settingsTab: 'general',
  after: async (dom) => {
    await dom.waitFor('select[aria-label="Mode switch animation"]');
    document.querySelector('select[aria-label="Mode switch animation"]')?.scrollIntoView({ block: 'center' });
    await dom.sleep(300);
  },
};
export default s;
