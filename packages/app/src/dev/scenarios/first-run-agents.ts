import { firstRunScenario } from '../first-run-scenario';

// First-run welcome: step 1, the four agents found by themselves, warming started, the look control.
export default firstRunScenario({
  name: 'first-run-agents',
  window: { width: 1440, height: 900 },
  firstRun: { step: 'agents' },
  after: async (dom) => {
    await dom.waitFor('[data-testid="agent-rows"] li[data-state="ready"]');
    await dom.sleep(400);
  },
});
