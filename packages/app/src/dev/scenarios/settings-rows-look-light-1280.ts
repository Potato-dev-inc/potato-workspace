import type { HarnessScenario } from '../types';
import { shotSteps, shotTab } from '../settings-rows-shots';

// Settings rows evidence: look, light theme, 1280 px wide.
const s: HarnessScenario = {
  name: 'settings-rows-look-light-1280',
  route: 'settings',
  settingsTab: shotTab.look,
  theme: 'light',
  window: { width: 1280, height: 820 },
  after: shotSteps.look,
};
export default s;
