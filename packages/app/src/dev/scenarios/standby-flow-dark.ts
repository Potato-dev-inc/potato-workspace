import type { HarnessScenario } from '../types';
import { SIDEBAR_PANES } from '../fixtures-sidebar';

// The sidebar with standby helpers under their agents: Ready, Resting, Starting; "Tester" is working in the chat under Sidebar rework.
const s: HarnessScenario = {
  name: 'standby-flow-dark',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1280, height: 900 },
  panes: SIDEBAR_PANES,
  storage: { 'pm.sidebar.groupBy': 'status' },
};
export default s;
