import type { HarnessScenario } from '../types';
import { SIDEBAR_PANES } from '../fixtures-sidebar';

// 1.1.9 standby row: the state word ("Opening session", "Ready") must fit its row; zoom sidebar, dark theme.
const s: HarnessScenario = {
  name: 'standby-row-zoom-dark',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1100, height: 700 },
  panes: SIDEBAR_PANES,
  storage: { 'pm.sidebar.groupBy': 'status', 'pm.sidebar.width': '200' },
  after: async (dom) => {
    await dom.waitFor('[data-testid="standby-row"]');
    document.documentElement.style.setProperty('--ui-scale', '1.3');
    await dom.sleep(300);
    await dom.sleep(500);
  },
};
export default s;
