import { ROUTINES_QUEUE } from '../routines-fixtures';
import type { HarnessScenario } from '../types';

// At most 3 at once, 3 running: two routines wait in a visible line ("Waiting for a free slot (3 running)").
const s: HarnessScenario = {
  name: 'routines-queue',
  route: 'cockpit',
  window: { width: 1200, height: 900 },
  routines: { view: ROUTINES_QUEUE },
  after: async (dom) => {
    await dom.click('button[aria-label="More"]');
    await dom.clickText('[role="menuitem"]', 'Routines');
    await dom.waitFor('[data-testid="routines-queue"]');
    await dom.sleep(500);
  },
};
export default s;
