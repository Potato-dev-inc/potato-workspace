import type { HarnessScenario } from '../types';

// Connect > Phone with a fixed address (notready), dark: one Public address card ("Keep one address"), the line and the QR agree.
const s: HarnessScenario = {
  name: 'phonefix-phone-notready-dark',
  route: 'cockpit',
  theme: 'dark',
  tunnel: 'stable-failed',
  window: { width: 1280, height: 1500 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-connect"]');
    await dom.click('[data-testid="side-connect"]');
    await dom.waitFor('[data-testid="connect-phones"]');
    await dom.click('[data-testid="connect-main-phone"]');
    await dom.waitFor('[data-testid="pairing-panel"]');
    await dom.click('[data-testid="connect-address"]');
    await dom.waitFor('[data-testid="connect-tunnel"]');
    await dom.sleep(900);
  },
};
export default s;
