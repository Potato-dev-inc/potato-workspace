import type { HarnessScenario } from '../types';
import { shotSteps, shotTab } from '../settings-rows-shots';

// Settings rows evidence: changed, dark theme, 1280 px wide.
const s: HarnessScenario = {
  name: 'settings-rows-changed-dark-1280',
  route: 'settings',
  settingsTab: shotTab.changed,
  theme: 'dark',
  window: { width: 1280, height: 820 },
  after: shotSteps.changed,
};
export default s;
