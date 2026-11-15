import { PANE_CLAUDE } from '../fixtures';
import { openFileTab } from '../../lib/file-tabs';
import { styledSheetBase64 } from '../../components/files/sheet-look-fixture';
import type { HarnessScenario } from '../types';

// A formatted Excel sheet (fills, borders, merged cells, widths) open in a tab beside the chat (light, 1100 wide).
const s: HarnessScenario = {
  name: 'sheet-look-light',
  route: 'cockpit',
  select: PANE_CLAUDE,
  theme: 'light',
  window: { width: 1100, height: 900 },
  after: async (dom) => {
    (globalThis as { __pmFileBase64?: Record<string, string> }).__pmFileBase64 = { 'october.xlsx': await styledSheetBase64() };
    openFileTab(PANE_CLAUDE, 'october.xlsx');
    await dom.waitFor('[data-testid="file-sheet-styled"]');
    await dom.sleep(1200);
  },
};
export default s;
