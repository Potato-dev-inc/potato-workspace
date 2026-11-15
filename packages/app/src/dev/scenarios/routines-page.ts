import type { HarnessScenario } from '../types';

// The Routines page: a weekday routine that ran late, a paused one, a chain, and the recent runs.
const s: HarnessScenario = {
  name: 'routines-page',
  route: 'cockpit',
  window: { width: 1200, height: 1100 },
  after: async (dom) => {
    await dom.click('button[aria-label="More"]');
    await dom.clickText('[role="menuitem"]', 'Routines');
    await dom.waitFor('.ck-routines');
    await dom.sleep(500);
  },
};
export default s;
