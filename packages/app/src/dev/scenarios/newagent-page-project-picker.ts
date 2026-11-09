import type { HarnessScenario } from '../types';
import { PANE_CLAUDE } from '../fixtures';

// The New agent page with the Project picker open: saved projects, folders agents run in, Add project…, Choose another folder….
const s: HarnessScenario = {
  name: 'newagent-page-project-picker',
  route: 'cockpit',
  select: PANE_CLAUDE,
  storage: {
    'pm.sidebar.projects': JSON.stringify([{ path: 'C:/work/shop' }, { path: 'C:/work/docs', name: 'Docs site' }, { path: 'D:/code/mobile-app' }]),
  },
  after: async (dom) => {
    await dom.click('button[aria-label="New agent"]');
    await dom.waitFor('[data-testid="na-folder"]');
    await dom.click('[data-testid="na-folder"]');
    await dom.waitFor('.ck-na-menu');
    await dom.sleep(500);
  },
};
export default s;
