import type { HarnessScenario } from '../types';

// Connect > Phone, simple view (problem), dark: one plain line, Fix it, folded details.
const s: HarnessScenario = {
  name: 'connect-simple-problem-dark',
  route: 'cockpit',
  theme: 'dark',
  tunnel: 'quick-error',
  window: { width: 1000, height: 700 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-connect"]');
    await dom.click('[data-testid="side-connect"]');
    await dom.waitFor('[data-testid="connect-simple"]');
    await dom.sleep(900);
  },
};
export default s;
