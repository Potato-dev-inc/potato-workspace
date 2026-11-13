import { PANE_CLAUDE } from '../fixtures';
import type { HarnessScenario } from '../types';

// A code file open in a tab beside the chat (dark, 1280 wide).
const s: HarnessScenario = {
  name: 'files-tab-dark-1280',
  route: 'cockpit',
  select: PANE_CLAUDE,
  theme: 'dark',
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
