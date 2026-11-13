import type { HarnessScenario } from '../types';
import { shotSteps, shotTab } from '../settings-rows-shots';

// Settings rows evidence: overview, dark theme, 900 px wide.
const s: HarnessScenario = {
  name: 'settings-rows-overview-dark-900',
  route: 'settings',
  settingsTab: shotTab.overview,
  theme: 'dark',
  window: { width: 900, height: 820 },
  after: shotSteps.overview,
};
export default s;
