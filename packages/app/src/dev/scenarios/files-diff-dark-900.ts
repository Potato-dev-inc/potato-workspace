import { PANE_CLAUDE } from '../fixtures';
import { openFileTab } from '../../lib/file-tabs';
import type { HarnessScenario } from '../types';

// The Changes switch on the file tab with two lines picked and Tell the agent (dark, 900 wide).
const s: HarnessScenario = {
  name: 'files-diff-dark-900',
  route: 'cockpit',
  select: PANE_CLAUDE,
  theme: 'dark',
  window: { width: 900, height: 800 },
  after: async (dom) => {
    // The right panel hides on a window this narrow, so the file is opened the way a link in the chat would.
    openFileTab(PANE_CLAUDE, 'src/auth.ts');
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
