import { PANE_CLAUDE } from '../fixtures';
import { openFileTab } from '../../lib/file-tabs';
import type { HarnessScenario } from '../types';

// A pdf file open in a tab beside the chat (light, 900 wide).
const s: HarnessScenario = {
  name: 'files-pdf-light-900',
  route: 'cockpit',
  select: PANE_CLAUDE,
  theme: 'light',
  window: { width: 900, height: 800 },
  after: async (dom) => {
    openFileTab(PANE_CLAUDE, 'paper.pdf');
    await dom.waitFor('.ck-sandbox');
    await dom.sleep(1200);
  },
};
export default s;
