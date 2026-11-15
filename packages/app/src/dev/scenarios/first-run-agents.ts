import { firstRunScenario } from '../first-run-scenario';

// First-run welcome: screen 1, the agents found, Set up everything (dark).
export default firstRunScenario({
  name: 'first-run-agents',
  window: { width: 1440, height: 900 },
  theme: 'dark',
  firstRun: { step: 'agents' },
  after: async (dom) => {
    await dom.waitFor('[data-testid="agent-rows"] li[data-state="ready"]');
    await dom.sleep(300);
  },
});
