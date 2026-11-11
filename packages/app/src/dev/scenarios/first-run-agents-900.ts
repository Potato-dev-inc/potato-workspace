import { firstRunScenario } from '../first-run-scenario';

// First-run welcome: step 1 at 900 wide.
export default firstRunScenario({
  name: 'first-run-agents-900',
  window: { width: 900, height: 700 },
  firstRun: { step: 'agents' },
  after: async (dom) => {
    await dom.waitFor('[data-testid="agent-rows"] li[data-state="ready"]');
    await dom.sleep(400);
  },
});
