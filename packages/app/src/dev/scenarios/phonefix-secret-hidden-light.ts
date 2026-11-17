import type { HarnessScenario } from '../types';

// Public address card: "Show secret" pressed, the secret hidden behind the eye button, light.
const s: HarnessScenario = {
  name: 'phonefix-secret-hidden-light',
  route: 'cockpit',
  theme: 'light',
  tunnel: 'stable',
  window: { width: 1280, height: 1500 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-connect"]');
    await dom.click('[data-testid="side-connect"]');
    await dom.waitFor('[data-testid="connect-phones"]');
    await dom.click('[data-testid="connect-address"]');
    await dom.waitFor('section[aria-label="Public address"]');
    await dom.clickText('button', 'Show secret');
    await dom.waitFor('[data-testid="stable-secret"]');
    await dom.sleep(300);
  },
};
export default s;
