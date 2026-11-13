import type { HarnessScenario } from '../types';
import { SIDEBAR_PANES } from '../fixtures-sidebar';

/** Evidence for the sidebar round (1113): project cards, row marks, footer. */
const s: HarnessScenario = {
  name: 'ui-sidebar-folded',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1280, height: 800 },
  panes: SIDEBAR_PANES,
  storage: {
    'pm.sidebar.projectsFolded': JSON.stringify(['c:/users/dev/work/potato-workspace', 'c:/users/dev/work/potato-site']),
    'pm.sidebar.pinned': JSON.stringify(['sb-plan']),
    'pm.sidebar.projects': JSON.stringify([{ path: 'C:/Users/dev/work/potato-workspace' }, { path: 'C:/Users/dev/work/potato-site' }, { path: 'C:/Users/dev/work/empty-project' }]),
  },
};
export default s;
