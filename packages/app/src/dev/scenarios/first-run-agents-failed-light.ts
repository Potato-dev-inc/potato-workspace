import { firstRunScenario } from '../first-run-scenario';

// First-run welcome: screen 1, a step failed three times: the shared block with Let Claude fix it (light).
export default firstRunScenario({
  name: 'first-run-agents-failed-light',
  window: { width: 1440, height: 900 },
  theme: 'light',
  firstRun: { step: 'agents', connectFails: true },
  after: async (dom) => {
    await dom.waitFor('[data-testid="agent-rows"] li[data-state="ready"]');
    await dom.sleep(300);
    await dom.click('[data-testid="set-up-everything"]');
    await dom.waitFor('[data-testid="first-run-setup-fix"]', 15000);
    await dom.sleep(500);
  },
});
