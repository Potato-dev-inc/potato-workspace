import type { HarnessScenario } from '../types';

// Settings > Agents > Standby helpers evidence, dark theme.
const s: HarnessScenario = {
  name: 'standby-helpers-dark',
  route: 'settings',
  settingsTab: 'agents',
  theme: 'dark',
  window: { width: 1280, height: 900 },
  after: async (dom) => {
    await dom.waitFor('[data-row="standby-helpers"]');
    await dom.waitFor('[data-testid="standby-row-sb-1"]');
    document.querySelector('[data-row="standby-helpers"]')?.scrollIntoView({ block: 'start' });
    await dom.sleep(500);
  },
};
export default s;
