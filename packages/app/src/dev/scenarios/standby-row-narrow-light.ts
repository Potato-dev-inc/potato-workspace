import type { HarnessScenario } from '../types';
import { SIDEBAR_PANES } from '../fixtures-sidebar';

// 1.1.9 standby row: the state word ("Opening session", "Ready") must fit its row; narrow sidebar, light theme.
const s: HarnessScenario = {
  name: 'standby-row-narrow-light',
  route: 'cockpit',
  theme: 'light',
  window: { width: 1100, height: 700 },
  panes: SIDEBAR_PANES,
  storage: { 'pm.sidebar.groupBy': 'status', 'pm.sidebar.width': '180' },
  after: async (dom) => {
    await dom.waitFor('[data-testid="standby-row"]');
    
    await dom.sleep(500);
  },
};
export default s;
