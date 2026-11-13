import type { HarnessScenario } from '../types';
import { shotSteps, shotTab } from '../settings-rows-shots';

// Settings rows evidence: toast, dark theme, 1280 px wide.
const s: HarnessScenario = {
  name: 'settings-rows-toast-dark-1280',
  route: 'settings',
  settingsTab: shotTab.toast,
  theme: 'dark',
  window: { width: 1280, height: 820 },
  after: shotSteps.toast,
};
export default s;
