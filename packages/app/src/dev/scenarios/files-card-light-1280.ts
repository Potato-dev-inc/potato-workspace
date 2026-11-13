import { PANE_CLAUDE } from '../fixtures';
import type { HarnessScenario } from '../types';

// The Files card in the right panel (light, 1280 wide): a folder opened, changed and new marks.
const s: HarnessScenario = {
  name: 'files-card-light-1280',
  route: 'cockpit',
  select: PANE_CLAUDE,
  theme: 'light',
  window: { width: 1280, height: 800 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="rail-files"] [data-path="src"]');
    await dom.click('[data-testid="rail-files"] [data-path="src"]');
    await dom.waitFor('[data-testid="rail-files"] [data-path="src/auth.ts"]');
    await dom.sleep(400);
  },
};
export default s;
