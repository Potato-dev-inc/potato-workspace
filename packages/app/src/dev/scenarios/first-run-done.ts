import { firstRunScenario } from '../first-run-scenario';

// First-run welcome: the last screen: three tips and "More you can set up".
export default firstRunScenario({
  name: 'first-run-done',
  window: { width: 1440, height: 900 },
  firstRun: { step: 'done' },
});
