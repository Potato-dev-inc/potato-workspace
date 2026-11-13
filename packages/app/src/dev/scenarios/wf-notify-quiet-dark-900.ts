import type { HarnessScenario } from '../types';
import { quietRow } from '../wf-notify-steps';

// Settings > Look and feel: the Quiet hours row switched on, dark, 900 px wide.
const s: HarnessScenario = {
  name: 'wf-notify-quiet-dark-900',
  route: 'settings',
  settingsTab: 'look',
  theme: 'dark',
  window: { width: 900, height: 820 },
  after: quietRow,
};
export default s;
