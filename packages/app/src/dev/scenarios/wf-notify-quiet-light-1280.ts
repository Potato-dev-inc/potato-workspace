import type { HarnessScenario } from '../types';
import { quietRow } from '../wf-notify-steps';

// Settings > Look and feel: the Quiet hours row switched on, light, 1280 px wide.
const s: HarnessScenario = {
  name: 'wf-notify-quiet-light-1280',
  route: 'settings',
  settingsTab: 'look',
  theme: 'light',
  window: { width: 1280, height: 900 },
  after: quietRow,
};
export default s;
