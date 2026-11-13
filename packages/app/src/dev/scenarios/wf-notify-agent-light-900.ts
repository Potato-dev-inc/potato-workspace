import type { HarnessScenario } from '../types';
import { agentRows } from '../wf-notify-steps';

// Settings > Agents > Claude: the Notifications rows, light, 900 px wide.
const s: HarnessScenario = {
  name: 'wf-notify-agent-light-900',
  route: 'settings',
  settingsTab: 'agents',
  theme: 'light',
  window: { width: 900, height: 820 },
  after: agentRows,
};
export default s;
