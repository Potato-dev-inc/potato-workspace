import type { HarnessScenario } from '../types';

// Connect, the relay card above the tabs with no relay yet: the prominent card with the one button (light).
const s: HarnessScenario = {
  name: 'relay-one-click-card-light',
  route: 'cockpit',
  theme: 'light',
  window: { width: 1000, height: 1250 },
  tunnel: 'quick',
  after: async (dom) => {
    await dom.waitFor('[data-testid="side-connect"]');
    await dom.click('[data-testid="side-connect"]');
    await dom.waitFor('[data-testid="connect-simple"]');
    await dom.waitFor('[data-testid="relay-card"]');
    await dom.sleep(600);
  },
};
export default s;
