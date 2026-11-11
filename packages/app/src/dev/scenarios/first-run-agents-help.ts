import { firstRunScenario } from '../first-run-scenario';

// First-run welcome: step 1 with "Help with an agent" open: the install and sign-in list, and the keep-ready note.
export default firstRunScenario({
  name: 'first-run-agents-help',
  window: { width: 1440, height: 900 },
  firstRun: { step: 'agents' },
  after: async (dom) => {
    await dom.waitFor('[data-testid="agent-rows"] li[data-state="ready"]');
    await dom.clickText('button', 'Help with an agent');
    await dom.sleep(500);
  },
});
