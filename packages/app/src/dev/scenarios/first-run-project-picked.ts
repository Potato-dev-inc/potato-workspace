import { firstRunScenario } from '../first-run-scenario';

// First-run welcome: screen 2, a folder picked: Done (dark).
export default firstRunScenario({
  name: 'first-run-project-picked',
  window: { width: 1440, height: 900 },
  theme: 'dark',
  firstRun: { step: 'project' },
  after: async (dom) => {
    await dom.waitFor('.fr-row');
    await dom.clickText('.fr-row', 'landing-page');
    await dom.waitFor('[data-testid="picked-project"]');
    await dom.sleep(400);
  },
});
