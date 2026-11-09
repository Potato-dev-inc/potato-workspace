import type { HarnessScenario } from '../types';
import { PANE_CLAUDE } from '../fixtures';

// The New agent page with saved projects, the Project chip closed.
const s: HarnessScenario = {
  name: 'newagent-page-projects',
  route: 'cockpit',
  select: PANE_CLAUDE,
  storage: {
    'pm.sidebar.projects': JSON.stringify([{ path: 'C:/work/shop' }, { path: 'C:/work/docs', name: 'Docs site' }, { path: 'D:/code/mobile-app' }]),
  },
  after: async (dom) => {
    await dom.click('button[aria-label="New agent"]');
    await dom.waitFor('[data-testid="na-folder"]');
    await dom.sleep(500);
  },
};
export default s;
