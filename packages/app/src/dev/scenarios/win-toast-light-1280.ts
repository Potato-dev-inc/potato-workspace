import type { HarnessScenario } from '../types';
import { pcRow } from '../wf-notify-steps';

// Settings > Look and feel: the "Notifications on this PC" row next to Quiet hours, light, 1280 px wide.
const s: HarnessScenario = {
  name: 'win-toast-light-1280',
  route: 'settings',
  settingsTab: 'look',
  theme: 'light',
  window: { width: 1280, height: 900 },
  after: pcRow,
};
export default s;
