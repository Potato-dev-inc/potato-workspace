import type { HarnessScenario } from '../types';
import { comfortLook } from '../comfort-steps';

// Settings > Look and feel > Comfort, dark, 1280 px wide.
const s: HarnessScenario = {
  name: 'comfort-text-100-dark-1280',
  route: 'settings',
  settingsTab: 'look',
  theme: 'dark',
  window: { width: 1280, height: 900 },
  after: comfortLook({ textScale: 100 }),
};
export default s;
