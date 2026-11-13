import type { HarnessScenario } from '../types';
import { shotSteps, shotTab } from '../settings-rows-shots';

// Settings rows evidence: changed, light theme, 1280 px wide.
const s: HarnessScenario = {
  name: 'settings-rows-changed-light-1280',
  route: 'settings',
  settingsTab: shotTab.changed,
  theme: 'light',
  window: { width: 1280, height: 820 },
  after: shotSteps.changed,
};
export default s;
