import { firstRunScenario } from '../first-run-scenario';

// First-run welcome: screen 1 after Set up everything worked (light).
export default firstRunScenario({
  name: 'first-run-agents-done-light',
  window: { width: 1440, height: 900 },
  theme: 'light',
  firstRun: { step: 'agents' },
  after: async (dom) => {
    await dom.waitFor('[data-testid="agent-rows"] li[data-state="ready"]');
    await dom.sleep(300);
    await dom.click('[data-testid="set-up-everything"]');
    await dom.waitFor('[data-testid="first-run-setup-done"]', 10000);
    await dom.sleep(400);
  },
});
