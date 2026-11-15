import type { HarnessScenario } from '../types';

// Settings > Agents > Standby helpers evidence, light theme.
const s: HarnessScenario = {
  name: 'standby-helpers-light',
  route: 'settings',
  settingsTab: 'agents',
  theme: 'light',
  window: { width: 1280, height: 900 },
  after: async (dom) => {
    await dom.waitFor('[data-row="standby-helpers"]');
    await dom.waitFor('[data-testid="standby-row-sb-1"]');
    document.querySelector('[data-row="standby-helpers"]')?.scrollIntoView({ block: 'start' });
    await dom.sleep(500);
  },
};
export default s;
