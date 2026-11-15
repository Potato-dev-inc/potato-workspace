import type { HarnessScenario } from '../types';
import { shotTab } from '../settings-rows-shots';

// Settings > Overview: the cards without an orange stripe, and the Setup checks list that keeps its last answer.
const s: HarnessScenario = {
  name: 'settings-tidy-overview-light',
  route: 'settings',
  settingsTab: shotTab.overview,
  theme: 'light',
  window: { width: 1280, height: 1000 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="setup-check"]');
    await dom.sleep(500);
  },
};
export default s;
