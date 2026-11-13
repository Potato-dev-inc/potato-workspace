import type { HarnessScenario } from '../types';
import { shotSteps, shotTab } from '../settings-rows-shots';

// Settings rows evidence: overview, light theme, 1280 px wide.
const s: HarnessScenario = {
  name: 'settings-rows-overview-light-1280',
  route: 'settings',
  settingsTab: shotTab.overview,
  theme: 'light',
  window: { width: 1280, height: 820 },
  after: shotSteps.overview,
};
export default s;
