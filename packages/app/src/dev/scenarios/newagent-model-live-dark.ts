import type { HarnessScenario } from '../types';
import { PANE_CLAUDE } from '../fixtures';

// The New agent page with the model picker open on the agent's own live list (names with descriptions).
const s: HarnessScenario = {
  name: 'newagent-model-live-dark',
  route: 'cockpit',
  theme: 'dark',
  select: PANE_CLAUDE,
  after: async (dom) => {
    (window as unknown as { __chatLane?: boolean }).__chatLane = true;
    await dom.click('button[aria-label="New agent"]');
    await dom.waitFor('[data-testid="na-model"]');
    await dom.click('[data-testid="na-model"]');
    await dom.waitFor('.mp-menu');
    await dom.sleep(500);
  },
};
export default s;
