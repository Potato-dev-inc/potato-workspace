import { firstRunScenario } from '../first-run-scenario';

// First-run welcome: Add skills to your agents, reached from the last screen.
export default firstRunScenario({
  name: 'first-run-pack',
  window: { width: 1440, height: 900 },
  firstRun: { step: 'done' },
  after: async (dom) => {
    await dom.clickText('[data-testid="more-links"] li:last-child button', 'Set up');
    await dom.waitFor('[data-testid="pack-found"]');
    await dom.sleep(300);
  },
});
