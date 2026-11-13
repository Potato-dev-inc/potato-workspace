import type { HarnessScenario } from '../types';
import { shotSteps, shotTab } from '../settings-rows-shots';

// Settings rows evidence: toast, light theme, 900 px wide.
const s: HarnessScenario = {
  name: 'settings-rows-toast-light-900',
  route: 'settings',
  settingsTab: shotTab.toast,
  theme: 'light',
  window: { width: 900, height: 820 },
  after: shotSteps.toast,
};
export default s;
