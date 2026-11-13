import type { HarnessScenario } from '../types';
import { quietRow } from '../wf-notify-steps';

// Settings > Look and feel: the Quiet hours row switched on, light, 900 px wide.
const s: HarnessScenario = {
  name: 'wf-notify-quiet-light-900',
  route: 'settings',
  settingsTab: 'look',
  theme: 'light',
  window: { width: 900, height: 820 },
  after: quietRow,
};
export default s;
