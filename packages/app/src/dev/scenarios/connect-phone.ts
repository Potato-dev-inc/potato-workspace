import type { HarnessScenario } from '../types';

// Connect > Phone: what is paired, then Pair a phone (opened) and Keep one address; alerts and sign-out below.
const s: HarnessScenario = {
  name: 'connect-phone',
  route: 'cockpit',
  window: { width: 1280, height: 1300 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-connect"]');
    await dom.click('[data-testid="side-connect"]');
    await dom.waitFor('[data-testid="connect-phones"]');
    await dom.click('[data-testid="connect-main-phone"]');
    await dom.waitFor('[data-testid="pairing-panel"]');
    await dom.sleep(500);
  },
};
export default s;
