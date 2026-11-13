import type { HarnessScenario } from '../types';
import { shotSteps, shotTab } from '../settings-rows-shots';

// Settings rows evidence: bridge, dark theme, 900 px wide.
const s: HarnessScenario = {
  name: 'settings-rows-bridge-dark-900',
  route: 'settings',
  settingsTab: shotTab.bridge,
  theme: 'dark',
  window: { width: 900, height: 820 },
  after: shotSteps.bridge,
};
export default s;
