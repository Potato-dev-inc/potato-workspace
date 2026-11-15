import { PANE_CLAUDE } from '../fixtures';
import { SMALL_TASK } from '../project-budget-fixtures';
import type { HarnessScenario } from '../types';

// The quiet right-size line after a turn: a small task on a big model.
const s: HarnessScenario = {
  name: 'right-size-line-light',
  route: 'cockpit',
  theme: 'light',
  select: PANE_CLAUDE,
  window: { width: 1000, height: 640 },
  projectBudget: { rightSize: SMALL_TASK },
  after: async (dom) => {
    await dom.clickText('[role="tab"]', 'Chat');
    await dom.waitFor('[data-testid="right-size-line"]');
    await dom.sleep(400);
  },
};
export default s;
