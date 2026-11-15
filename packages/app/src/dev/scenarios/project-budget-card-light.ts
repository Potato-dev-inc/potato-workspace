import { PANE_CLAUDE } from '../fixtures';
import { REACHED } from '../project-budget-fixtures';
import type { HarnessScenario } from '../types';

// The project budget card above a chat: the project used its turns for today.
const s: HarnessScenario = {
  name: 'project-budget-card-light',
  route: 'cockpit',
  theme: 'light',
  select: PANE_CLAUDE,
  window: { width: 1000, height: 640 },
  projectBudget: { status: REACHED },
  after: async (dom) => {
    await dom.clickText('[role="tab"]', 'Chat');
    await dom.waitFor('[data-testid="project-budget-card"]');
    await dom.sleep(400);
  },
};
export default s;
