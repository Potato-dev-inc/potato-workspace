import type { HarnessScenario } from '../types';
import { PANE_CLAUDE } from '../fixtures';

// Workflows (Labs): the New agent page with a workflow picked. The agent and model chips are locked, one line says what starts.
const s: HarnessScenario = {
  name: 'workflow-newagent-dark',
  route: 'cockpit',
  theme: 'dark',
  workflows: true,
  window: { width: 1000, height: 640 },
  select: PANE_CLAUDE,
  after: async (dom) => {
    await dom.click('button[aria-label="New agent"]');
    await dom.waitFor('[data-testid="na-ask"]');
    await dom.click('[data-testid="na-workflow"]');
    await dom.clickText('[role="menuitemradio"]', 'Haiku router');
    await dom.waitFor('[data-testid="na-wf-summary"]');
    await dom.sleep(500);
  },
};
export default s;
