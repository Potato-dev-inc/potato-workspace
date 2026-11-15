import type { HarnessScenario } from '../types';

// The Today page (Labs): one line for the whole day, the detail card for the newest point. timeline-today-light.
const s: HarnessScenario = {
  name: 'timeline-today-light',
  route: 'cockpit',
  theme: 'light',
  window: { width: 1280, height: 1000 },
  timeline: true,
  after: async (dom) => {
    await dom.waitFor('button[aria-label="Today"]', 15000);
    await dom.click('button[aria-label="Today"]');
    await dom.waitFor('[data-testid="timeline-detail"]', 15000);
    await dom.sleep(900);
  },
};
export default s;
