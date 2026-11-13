import { PANE_CLAUDE } from '../fixtures';
import { openFileTab } from '../../lib/file-tabs';
import type { HarnessScenario } from '../types';

// A code file open in a tab beside the chat (dark, 900 wide).
const s: HarnessScenario = {
  name: 'files-tab-dark-900',
  route: 'cockpit',
  select: PANE_CLAUDE,
  theme: 'dark',
  window: { width: 900, height: 800 },
  after: async (dom) => {
    // The right panel hides on a window this narrow, so the file is opened the way a link in the chat would.
    openFileTab(PANE_CLAUDE, 'src/auth.ts');
    await dom.waitFor('.cm-line');
    await dom.sleep(900);
  },
};
export default s;
