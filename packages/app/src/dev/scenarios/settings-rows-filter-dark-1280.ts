import type { HarnessScenario } from '../types';
import { shotSteps, shotTab } from '../settings-rows-shots';

// Settings rows evidence: filter, dark theme, 1280 px wide.
const s: HarnessScenario = {
  name: 'settings-rows-filter-dark-1280',
  route: 'settings',
  settingsTab: shotTab.filter,
  theme: 'dark',
  window: { width: 1280, height: 820 },
  after: shotSteps.filter,
};
export default s;
