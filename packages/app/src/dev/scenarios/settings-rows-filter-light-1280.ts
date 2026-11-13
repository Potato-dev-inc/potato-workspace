import type { HarnessScenario } from '../types';
import { shotSteps, shotTab } from '../settings-rows-shots';

// Settings rows evidence: filter, light theme, 1280 px wide.
const s: HarnessScenario = {
  name: 'settings-rows-filter-light-1280',
  route: 'settings',
  settingsTab: shotTab.filter,
  theme: 'light',
  window: { width: 1280, height: 820 },
  after: shotSteps.filter,
};
export default s;
