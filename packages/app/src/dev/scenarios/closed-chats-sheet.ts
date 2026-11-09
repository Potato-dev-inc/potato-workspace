import type { HarnessScenario } from '../types';
import { SIDEBAR_PANES } from '../fixtures-sidebar';
import { EXAMPLE_CLOSED_CHATS } from '../closed-chats-fixtures';

/** The sidebar's "Closed chats" row opened: three closed chats with Reopen and Delete. */
const s: HarnessScenario = {
  name: 'closed-chats-sheet',
  route: 'cockpit',
  theme: 'dark',
  panes: SIDEBAR_PANES,
  closedChats: { chats: EXAMPLE_CLOSED_CHATS },
  storage: {
    'pm.sidebar.projects': JSON.stringify([{ path: 'C:/Users/dev/work/potato-workspace' }, { path: 'C:/Users/dev/work/potato-site' }]),
  },
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-closed-chats"]');
    await dom.clickText('[data-testid="side-closed-chats"]', 'Closed chats');
    await dom.waitFor('.ck-closed-row');
    await dom.sleep(500);
  },
};
export default s;
