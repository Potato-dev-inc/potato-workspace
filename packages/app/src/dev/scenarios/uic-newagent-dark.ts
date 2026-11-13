import type { HarnessScenario } from '../types';
import { PANE_CLAUDE } from '../fixtures';

// New agent page (UI composer area): dark, 1280 wide.
const s: HarnessScenario = {
  name: 'uic-newagent-dark',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1280, height: 760 },
  select: PANE_CLAUDE,
  after: async (dom) => {
    await dom.click('button[aria-label="New agent"]');
    await dom.waitFor('[data-testid="na-ask"]');
    await dom.sleep(500);
  },
};
export default s;
