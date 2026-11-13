import type { HarnessScenario } from '../types';
import { quietRow } from '../wf-notify-steps';

// Settings > Look and feel: the Quiet hours row switched on, dark, 1280 px wide.
const s: HarnessScenario = {
  name: 'wf-notify-quiet-dark-1280',
  route: 'settings',
  settingsTab: 'look',
  theme: 'dark',
  window: { width: 1280, height: 900 },
  after: quietRow,
};
export default s;
