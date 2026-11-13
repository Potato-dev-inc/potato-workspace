import type { HarnessScenario } from '../types';
import { agentRows } from '../wf-notify-steps';

// Settings > Agents > Claude: the Notifications rows, dark, 1280 px wide.
const s: HarnessScenario = {
  name: 'wf-notify-agent-dark-1280',
  route: 'settings',
  settingsTab: 'agents',
  theme: 'dark',
  window: { width: 1280, height: 900 },
  after: agentRows,
};
export default s;
