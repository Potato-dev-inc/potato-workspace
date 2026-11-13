import type { HarnessScenario } from '../types';
import { shotSteps, shotTab } from '../settings-rows-shots';

// Settings rows evidence: look, dark theme, 900 px wide.
const s: HarnessScenario = {
  name: 'settings-rows-look-dark-900',
  route: 'settings',
  settingsTab: shotTab.look,
  theme: 'dark',
  window: { width: 900, height: 820 },
  after: shotSteps.look,
};
export default s;
