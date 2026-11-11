import type { HarnessScenario } from '../types';
import { PANE_CLAUDE } from '../fixtures';

// The New agent page with the model picker open: Default (naming the default model) first, then the agent's models.
const s: HarnessScenario = {
  name: 'newagent-model-picker',
  route: 'cockpit',
  select: PANE_CLAUDE,
  after: async (dom) => {
    await dom.click('button[aria-label="New agent"]');
    await dom.waitFor('[data-testid="na-model"]');
    await dom.click('[data-testid="na-model"]');
    await dom.waitFor('.mp-menu');
    await dom.sleep(500);
  },
};
export default s;
