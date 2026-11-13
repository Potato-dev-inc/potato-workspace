import { PANE_CLAUDE } from '../fixtures';
import type { HarnessScenario } from '../types';

// The Changes switch on the file tab with two lines picked and Tell the agent (dark, 1280 wide).
const s: HarnessScenario = {
  name: 'files-diff-dark-1280',
  route: 'cockpit',
  select: PANE_CLAUDE,
  theme: 'dark',
  window: { width: 1280, height: 800 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="rail-files"] [data-path="src"]');
    await dom.click('[data-testid="rail-files"] [data-path="src"]');
    await dom.waitFor('[data-testid="rail-files"] [data-path="src/auth.ts"]');
    await dom.click('[data-testid="rail-files"] [data-path="src/auth.ts"]');
    await dom.waitFor('.ck-file');
    await dom.clickText('.ck-file [role="tab"]', 'Changes');
    await dom.waitFor('[data-testid="file-diff"] [role="option"]');
    const lines = document.querySelectorAll<HTMLElement>('[data-testid="file-diff"] [role="option"]');
    lines[5]?.click();
    lines[7]?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    await dom.sleep(500);
  },
};
export default s;
