import type { HarnessScenario } from '../types';
import { SIDEBAR_PANES } from '../fixtures-sidebar';
import { openNewStandby } from '../../lib/standbyHelpers';

// The Add a helper popover under "Sidebar rework".
const s: HarnessScenario = {
  name: 'standby-popover-dark',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1280, height: 900 },
  panes: SIDEBAR_PANES,
  storage: { 'pm.sidebar.groupBy': 'status' },
  after: async (dom) => {
    await dom.waitFor('[data-testid="standby-row"]');
    openNewStandby('C:/Users/dev/work/potato-workspace', 'sb-rework', { x: 300, y: 150 });
    await dom.waitFor('[data-testid="add-helper"]');
    await dom.sleep(400);
  },
};
export default s;
