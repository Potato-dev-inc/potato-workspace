import type { HarnessScenario } from '../types';
import { SIDEBAR_PANES } from '../fixtures-sidebar';

/** The sidebar in its Projects view: two added projects, one only seen, a pinned agent, a helper under its parent. */
const s: HarnessScenario = {
  name: 'cockpit-sidebar-light',
  route: 'cockpit',
  theme: 'light',
  panes: SIDEBAR_PANES,
  storage: {
    'pm.sidebar.pinned': JSON.stringify(['sb-plan']),
    'pm.sidebar.projects': JSON.stringify([{ path: 'C:/Users/dev/work/potato-workspace' }, { path: 'C:/Users/dev/work/potato-site' }, { path: 'C:/Users/dev/work/empty-project' }]),
  },
};
export default s;
