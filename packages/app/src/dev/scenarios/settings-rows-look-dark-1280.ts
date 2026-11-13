import type { HarnessScenario } from '../types';
import { shotSteps, shotTab } from '../settings-rows-shots';

// Settings rows evidence: look, dark theme, 1280 px wide.
const s: HarnessScenario = {
  name: 'settings-rows-look-dark-1280',
  route: 'settings',
  settingsTab: shotTab.look,
  theme: 'dark',
  window: { width: 1280, height: 820 },
  after: shotSteps.look,
};
export default s;
