import type { HarnessScenario } from '../types';
import { PANE_CLAUDE } from '../fixtures';
import { markStep, resetGettingStarted, seedSteps } from '../../lib/getting-started';

// The Getting started card on the New agent page: 2 of 6 done.
const s: HarnessScenario = {
  name: 'app-ux-getting-started-1280',
  route: 'cockpit',
  select: PANE_CLAUDE,
  window: { width: 1280, height: 820 },
  after: async (dom) => {
    await dom.sleep(800);
    resetGettingStarted();
    seedSteps([]);
    markStep('second');
    markStep('phone');
    await dom.click('[data-testid="side-new-agent"]');
    await dom.waitFor('[data-testid="na-ask"]');
    await dom.waitFor('[data-testid="getting-started"]', 3000);
    document.querySelector('[data-testid="getting-started"]')?.scrollIntoView({ block: 'center' });
    await dom.sleep(500);
  },
};
export default s;
