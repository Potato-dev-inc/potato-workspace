import type { HarnessScenario } from '../types';

// Connect > Phone, simple view (default), light: one line, the code, one status line.
const s: HarnessScenario = {
  name: 'connect-simple-default-light',
  route: 'cockpit',
  theme: 'light',
  tunnel: 'quick',
  window: { width: 1000, height: 860 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-connect"]');
    await dom.click('[data-testid="side-connect"]');
    await dom.waitFor('[data-testid="connect-simple"]');
    await dom.sleep(900);
  },
};
export default s;
