import { firstRunScenario } from '../first-run-scenario';

// First-run welcome: step 2, the files that change and the one button.
export default firstRunScenario({
  name: 'first-run-connect',
  window: { width: 1440, height: 900 },
  firstRun: { step: 'connect' },
  after: async (dom) => {
    await dom.waitFor('[data-testid="connect-files"]');
  },
});
