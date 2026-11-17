import type { HarnessScenario } from '../types';

// Connect > Phone, simple view (advanced), dark: Advanced opened: plain lines first, then the old controls.
const s: HarnessScenario = {
  name: 'connect-simple-advanced-dark',
  route: 'cockpit',
  theme: 'dark',
  tunnel: 'quick',
  window: { width: 1000, height: 1500 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-connect"]');
    await dom.click('[data-testid="side-connect"]');
    await dom.waitFor('[data-testid="connect-simple"]');
    await dom.click('[data-testid="connect-advanced"] summary');
    await dom.waitFor('[data-testid="connect-adv-terms"]');
    await dom.sleep(900);
  },
};
export default s;
