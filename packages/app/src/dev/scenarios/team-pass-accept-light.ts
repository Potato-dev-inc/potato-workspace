import { teamPageLend, teamPageState } from '../team-page-fixtures';
import { tasksView } from '../team-tasks-fixtures';
import type { HarnessScenario } from '../types';

// The receiver side: Accept open on a task with a repo, Also get the repo ticked, own-risk box shows, light theme.
const s: HarnessScenario = {
  name: 'team-pass-accept-light',
  route: 'cockpit',
  theme: 'light',
  window: { width: 1100, height: 1500 },
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
    await dom.clickText('button', 'Accept…');
    await dom.waitFor('[data-testid="accept-repo"]');
    await dom.click('[data-testid="accept-repo"]');
    await dom.sleep(500);
  },
};
export default s;
