import { firstRunScenario } from '../first-run-scenario';
import { demoPanes, walkToTry } from '../first-run-walk';

// First-run welcome: step 4 after the click: Claude works and the Codex helper is listed under it.
export default firstRunScenario({
  name: 'first-run-task-running',
  window: { width: 1440, height: 900 },
  firstRun: { step: 'agents', connected: true },
  panes: demoPanes(),
  after: async (dom) => {
    await walkToTry(dom);
    await dom.clickText('button', 'Open Claude and send');
    await dom.waitFor('[data-testid="task-helpers"] li');
    await dom.sleep(400);
  },
});
