import type { HarnessScenario } from '../types';
import { SIDEBAR_PANES } from '../fixtures-sidebar';

/** Evidence for the sidebar round (1113): project cards, row marks, footer. */
const s: HarnessScenario = {
  name: 'ui-sidebar-light-900',
  route: 'cockpit',
  theme: 'light',
  window: { width: 900, height: 700 },
  panes: SIDEBAR_PANES,
  storage: {
    'pm.sidebar.pinned': JSON.stringify(['sb-plan']),
    'pm.sidebar.projects': JSON.stringify([{ path: 'C:/Users/dev/work/potato-workspace' }, { path: 'C:/Users/dev/work/potato-site' }, { path: 'C:/Users/dev/work/empty-project' }]),
  },
};
export default s;
