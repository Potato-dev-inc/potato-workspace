import type { HarnessScenario } from '../types';
import { agentRows } from '../wf-notify-steps';

// Settings > Agents > Claude: the Notifications rows, dark, 900 px wide.
const s: HarnessScenario = {
  name: 'wf-notify-agent-dark-900',
  route: 'settings',
  settingsTab: 'agents',
  theme: 'dark',
  window: { width: 900, height: 820 },
  after: agentRows,
};
export default s;
