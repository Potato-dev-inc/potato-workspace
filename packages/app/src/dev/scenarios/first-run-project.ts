import { firstRunScenario } from '../first-run-scenario';

// First-run welcome: screen 2, no folder yet: Skip for now (dark).
export default firstRunScenario({
  name: 'first-run-project',
  window: { width: 1440, height: 900 },
  theme: 'dark',
  firstRun: { step: 'project' },
  after: async (dom) => {
    await dom.waitFor('.fr-row');
    await dom.sleep(300);
  },
});
