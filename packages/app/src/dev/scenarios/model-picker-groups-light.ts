import type { HarnessScenario } from '../types';
import { PANE_CLAUDE } from '../fixtures';

// The model picker open on a list that spans makers: grouped, the chosen model ticked.
const s: HarnessScenario = {
  name: 'model-picker-groups-light',
  route: 'cockpit',
  theme: 'light',
  select: PANE_CLAUDE,
  after: async (dom) => {
    (window as unknown as { __chatLane?: boolean; __mixedModels?: boolean }).__chatLane = true;
    (window as unknown as { __mixedModels?: boolean }).__mixedModels = true;
    await dom.click('button[aria-label="New agent"]');
    await dom.waitFor('[data-testid="na-model"]');
    await dom.click('[data-testid="na-model"]');
    await dom.waitFor('.mp-menu');
    await dom.sleep(500);
  },
};
export default s;
