import type { HarnessScenario } from '../types';
import { PANE_CLAUDE } from '../fixtures';

// The New agent page with the + menu open: the "Work on a copy" switch, turned on.
const s: HarnessScenario = {
  name: 'n5copy-newagent-dark',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1100, height: 700 },
  select: PANE_CLAUDE,
  after: async (dom) => {
    await dom.sleep(700);
    await dom.click('button.ck-side-new--primary');
    await dom.waitFor('[data-testid="na-ask"]');
    await dom.sleep(400);
    await dom.click('button[aria-label="Add to your message"]');
    await dom.waitFor('#na-copy-label');
    await dom.click('[role="switch"][aria-labelledby="na-copy-label"]');
    await dom.sleep(400);
  },
};
export default s;
