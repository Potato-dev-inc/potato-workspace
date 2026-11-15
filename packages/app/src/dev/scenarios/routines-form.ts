import type { HarnessScenario } from '../types';

// The new routine form: when (weekdays, 09:00), project, agent, task, copy and "tell me".
const s: HarnessScenario = {
  name: 'routines-form',
  route: 'cockpit',
  window: { width: 1200, height: 1100 },
  after: async (dom) => {
    await dom.click('button[aria-label="More"]');
    await dom.clickText('[role="menuitem"]', 'Routines');
    await dom.waitFor('.ck-routines');
    await dom.clickText('button', 'New routine');
    await dom.waitFor('.ck-routines-form');
    await dom.sleep(500);
  },
};
export default s;
