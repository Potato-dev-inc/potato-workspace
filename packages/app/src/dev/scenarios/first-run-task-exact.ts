import { firstRunScenario } from '../first-run-scenario';
import { demoPanes, walkToTry } from '../first-run-walk';

// First-run welcome: step 4 with the plain summary and "See the exact words" opened.
export default firstRunScenario({
  name: 'first-run-task-exact',
  window: { width: 1440, height: 900 },
  firstRun: { step: 'agents', connected: true },
  panes: demoPanes(),
  after: async (dom) => {
    await walkToTry(dom);
    await dom.clickText('button', 'See the exact words');
    await dom.sleep(300);
  },
});
