import { firstRunScenario } from '../first-run-scenario';
import { demoPanes, walkToTry } from '../first-run-walk';

// First-run welcome: step 4 before the click: the Codex review prompt, Claude as the main agent.
export default firstRunScenario({
  name: 'first-run-task',
  window: { width: 1440, height: 900 },
  firstRun: { step: 'agents', connected: true },
  panes: demoPanes(),
  after: walkToTry,
});
