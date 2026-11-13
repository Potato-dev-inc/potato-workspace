import type { HarnessScenario } from '../types';
import { PANE_CLAUDE } from '../fixtures';

// New agent page (UI composer area): light, 900 wide.
const s: HarnessScenario = {
  name: 'uic-newagent-light',
  route: 'cockpit',
  theme: 'light',
  window: { width: 900, height: 700 },
  select: PANE_CLAUDE,
  after: async (dom) => {
    await dom.click('button[aria-label="New agent"]');
    await dom.waitFor('[data-testid="na-ask"]');
    await dom.sleep(500);
  },
};
export default s;
