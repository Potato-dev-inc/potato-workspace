import { PANE_CLAUDE } from '../fixtures';
import type { HarnessScenario } from '../types';

// A file tab with its menu: Open in a new window (dark, 1280 wide).
const s: HarnessScenario = {
  name: 'tabwin-menu-dark-1280',
  route: 'cockpit',
  select: PANE_CLAUDE,
  theme: 'dark',
  window: { width: 1280, height: 800 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="rail-files"] [data-path="src"]');
    await dom.waitFor('[data-testid="rail-files"] [data-path="src"]');
    await dom.click('[data-testid="rail-files"] [data-path="src"]');
    await dom.waitFor('[data-testid="rail-files"] [data-path="src/auth.ts"]');
    await dom.click('[data-testid="rail-files"] [data-path="src/auth.ts"]');
    await dom.waitFor('.cm-line');
    const tab = (await dom.waitFor('.ck-ftab:not(.ck-ftab--agent) .ck-ftab-main')) as HTMLElement;
    tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 100 }));
    await dom.waitFor('[data-testid="tab-menu-window"]');
    await dom.sleep(500);
  },
};
export default s;
