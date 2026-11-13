import type { HarnessScenario } from '../types';
import { shotSteps, shotTab } from '../settings-rows-shots';

// Settings rows evidence: filter, light theme, 900 px wide.
const s: HarnessScenario = {
  name: 'settings-rows-filter-light-900',
  route: 'settings',
  settingsTab: shotTab.filter,
  theme: 'light',
  window: { width: 900, height: 820 },
  after: shotSteps.filter,
};
export default s;
