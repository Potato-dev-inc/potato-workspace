import type { HarnessScenario } from '../types';
import { shotSteps, shotTab } from '../settings-rows-shots';

// Settings rows evidence: bridge, dark theme, 1280 px wide.
const s: HarnessScenario = {
  name: 'settings-rows-bridge-dark-1280',
  route: 'settings',
  settingsTab: shotTab.bridge,
  theme: 'dark',
  window: { width: 1280, height: 820 },
  after: shotSteps.bridge,
};
export default s;
