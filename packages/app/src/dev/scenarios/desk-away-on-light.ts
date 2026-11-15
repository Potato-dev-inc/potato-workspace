import type { HarnessScenario } from '../types';

// Leaving my desk on the PC: the banner "Away · phone has control" with I'm back (screen control locked).
const s: HarnessScenario = {
  name: 'desk-away-on-light',
  route: 'cockpit',
  theme: 'light',
  window: { width: 1100, height: 700 },
  desk: { away: true, length: 'four_hours', started_ms: Date.now(), until_ms: Date.now() + 4 * 3_600_000, by: 'pc', lock_screen: true, phones: 1 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="desk-banner"]', 15000);
    await dom.sleep(400);
  },
};
export default s;
