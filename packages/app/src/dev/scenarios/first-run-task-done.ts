import { firstRunScenario } from '../first-run-scenario';
import { demoPanes, finishDemo, walkToTry } from '../first-run-walk';

// First-run welcome: step 4 when the helper has answered: "It worked", the helper done, the time.

const panes = demoPanes();

export default firstRunScenario({
  name: 'first-run-task-done',
  window: { width: 1440, height: 900 },
  firstRun: { step: 'agents', connected: true },
  panes,
  after: async (dom) => {
    await walkToTry(dom);
    await dom.clickText('button', 'Open Claude and send');
    await dom.waitFor('[data-testid="task-helpers"] li');
    await dom.sleep(1200);
    await finishDemo(panes);
    await dom.waitFor('[data-testid="task-done"]', 6000);
    await dom.sleep(300);
  },
});
