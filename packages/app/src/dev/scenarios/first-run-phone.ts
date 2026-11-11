import { firstRunScenario } from '../first-run-scenario';

// First-run welcome: Use your phone, reached from the last screen.
export default firstRunScenario({
  name: 'first-run-phone',
  window: { width: 1440, height: 900 },
  firstRun: { step: 'done' },
  after: async (dom) => {
    await dom.clickText('[data-testid="more-links"] li:first-child button', 'Set up');
    await dom.waitFor('#fr-phone-t');
    await dom.sleep(300);
  },
});
