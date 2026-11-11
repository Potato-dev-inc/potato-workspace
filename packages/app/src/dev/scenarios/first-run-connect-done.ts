import { firstRunScenario } from '../first-run-scenario';

// First-run welcome: step 2 after the button: a tick, Undo, and Continue is on.
export default firstRunScenario({
  name: 'first-run-connect-done',
  window: { width: 1440, height: 900 },
  firstRun: { step: 'connect' },
  after: async (dom) => {
    await dom.waitFor('[data-testid="connect-files"]');
    await dom.clickText('button', 'Add Potato Workspace to');
    await dom.waitFor('[data-testid="connect-done"]');
    await dom.sleep(300);
  },
});
