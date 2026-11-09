import type { HarnessScenario } from '../types';
import { SIDEBAR_PANES } from '../fixtures-sidebar';

/** The sidebar grouped by status (the old Needs you / Working / Idle), with the footer's More menu open. */
const s: HarnessScenario = {
  name: 'cockpit-sidebar-status',
  route: 'cockpit',
  panes: SIDEBAR_PANES,
  storage: { 'pm.sidebar.groupBy': 'status', 'pm.sidebar.pinned': JSON.stringify(['sb-plan']) },
  after: async (dom) => {
    await dom.click('button[aria-label="More"]');
    await dom.sleep(400);
  },
};
export default s;
