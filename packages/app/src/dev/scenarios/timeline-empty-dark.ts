import type { HarnessScenario } from '../types';

// The Today page with nothing in it yet.
const s: HarnessScenario = {
  name: 'timeline-empty-dark',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1280, height: 700 },
  timeline: { empty: true },
  after: async (dom) => {
    await dom.waitFor('button[aria-label="Today"]', 15000);
    await dom.click('button[aria-label="Today"]');
    await dom.waitFor('[data-testid="timeline-empty"]', 15000);
    await dom.sleep(500);
  },
};
export default s;
