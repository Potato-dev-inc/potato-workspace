import { firstRunScenario } from '../first-run-scenario';

// First-run welcome: step 2 at 900 wide.
export default firstRunScenario({
  name: 'first-run-connect-900',
  window: { width: 900, height: 700 },
  firstRun: { step: 'connect' },
  after: async (dom) => {
    await dom.waitFor('[data-testid="connect-files"]');
  },
});
