import { PANE_CLAUDE } from '../fixtures';
import { openFileTab } from '../../lib/file-tabs';
import type { HarnessScenario } from '../types';

// A xlsx file open in a tab beside the chat (light, 900 wide).
const s: HarnessScenario = {
  name: 'files-xlsx-light-900',
  route: 'cockpit',
  select: PANE_CLAUDE,
  theme: 'light',
  window: { width: 900, height: 800 },
  after: async (dom) => {
    openFileTab(PANE_CLAUDE, 'shop.xlsx');
    await dom.waitFor('.ck-sheet-table');
    await dom.sleep(1200);
  },
};
export default s;
