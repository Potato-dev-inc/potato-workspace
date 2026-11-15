import { teamPageLend, teamPageState } from '../team-page-fixtures';
import { tasksView } from '../team-tasks-fixtures';
import type { HarnessScenario } from '../types';

// The Tasks tab: tasks passed to me in each main state, and the ones I passed, dark theme.
const s: HarnessScenario = {
  name: 'team-pass-tasks-dark',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1100, height: 1900 },
  team: teamPageState(),
  lend: teamPageLend(),
  tasks: tasksView(),
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-connect"]');
    await dom.click('[data-testid="side-connect"]');
    await dom.click('[data-testid="connect-tab-team"]');
    await dom.waitFor('[data-testid="tab-tasks"]');
    await dom.click('[data-testid="tab-tasks"]');
    await dom.waitFor('[data-testid="task-r1"]');
    await dom.sleep(500);
  },
};
export default s;
