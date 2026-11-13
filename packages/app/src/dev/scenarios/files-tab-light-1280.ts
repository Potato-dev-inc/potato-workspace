import { PANE_CLAUDE } from '../fixtures';
import type { HarnessScenario } from '../types';

// A code file open in a tab beside the chat (light, 1280 wide).
const s: HarnessScenario = {
  name: 'files-tab-light-1280',
  route: 'cockpit',
  select: PANE_CLAUDE,
  theme: 'light',
  window: { width: 1280, height: 800 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="rail-files"] [data-path="src"]');
    await dom.click('[data-testid="rail-files"] [data-path="src"]');
    await dom.waitFor('[data-testid="rail-files"] [data-path="src/auth.ts"]');
    await dom.click('[data-testid="rail-files"] [data-path="src/auth.ts"]');
    await dom.waitFor('.cm-line');
    await dom.sleep(900);
  },
};
export default s;
