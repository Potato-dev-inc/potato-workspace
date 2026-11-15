import { PANE_CLAUDE } from '../fixtures';
import type { HarnessScenario } from '../types';

// The Files card with Material Icon Theme icons, two folders open (dim).
const s: HarnessScenario = {
  name: 'files-icons-dim',
  route: 'cockpit',
  select: PANE_CLAUDE,
  theme: 'dim',
  window: { width: 1280, height: 800 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="rail-files"] [data-path="src"]');
    await dom.click('[data-testid="rail-files"] [data-path="src"]');
    await dom.waitFor('[data-path="src/auth.ts"]');
    await dom.click('[data-testid="rail-files"] [data-path="docs"]');
    await dom.sleep(500);
    document.querySelector('[data-testid="rail-files"]')?.scrollIntoView({ block: 'start' });
    await dom.sleep(300);
  },
};
export default s;
