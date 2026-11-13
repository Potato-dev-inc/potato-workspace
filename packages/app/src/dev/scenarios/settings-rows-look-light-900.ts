import type { HarnessScenario } from '../types';
import { shotSteps, shotTab } from '../settings-rows-shots';

// Settings rows evidence: look, light theme, 900 px wide.
const s: HarnessScenario = {
  name: 'settings-rows-look-light-900',
  route: 'settings',
  settingsTab: shotTab.look,
  theme: 'light',
  window: { width: 900, height: 820 },
  after: shotSteps.look,
};
export default s;
