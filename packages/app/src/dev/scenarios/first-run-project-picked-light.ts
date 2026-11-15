import { firstRunScenario } from '../first-run-scenario';

// First-run welcome: screen 2, a folder picked: Done (light).
export default firstRunScenario({
  name: 'first-run-project-picked-light',
  window: { width: 1440, height: 900 },
  theme: 'light',
  firstRun: { step: 'project' },
  after: async (dom) => {
    await dom.waitFor('.fr-row');
    await dom.clickText('.fr-row', 'landing-page');
    await dom.waitFor('[data-testid="picked-project"]');
    await dom.sleep(400);
  },
});
