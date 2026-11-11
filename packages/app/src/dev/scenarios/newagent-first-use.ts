import type { HarnessScenario } from '../types';
import { PANE_CLAUDE } from '../fixtures';

// The New agent page on first use: "New agent" in the header, the question over the box, and one line about cards.
const s: HarnessScenario = {
  name: 'newagent-first-use',
  route: 'cockpit',
  select: PANE_CLAUDE,
  after: async (dom) => {
    await dom.click('button[aria-label="New agent"]');
    await dom.waitFor('[data-testid="na-ask"]');
    await dom.sleep(500);
  },
};
export default s;
