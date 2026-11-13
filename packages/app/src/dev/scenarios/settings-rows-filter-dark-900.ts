import type { HarnessScenario } from '../types';
import { shotSteps, shotTab } from '../settings-rows-shots';

// Settings rows evidence: filter, dark theme, 900 px wide.
const s: HarnessScenario = {
  name: 'settings-rows-filter-dark-900',
  route: 'settings',
  settingsTab: shotTab.filter,
  theme: 'dark',
  window: { width: 900, height: 820 },
  after: shotSteps.filter,
};
export default s;
