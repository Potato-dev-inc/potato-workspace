import type { HarnessScenario } from '../types';

// The quiet start-up check: one line with a Fix when an agent is signed out. Nothing blocks the window.
const s: HarnessScenario = {
  name: 'flow-startup',
  route: 'cockpit',
  window: { width: 1280, height: 800 },
  startupCheck: true,
  after: async (dom) => {
    await dom.waitFor('[data-testid="startup-check"]', 9000);
    await dom.sleep(300);
  },
};
export default s;
