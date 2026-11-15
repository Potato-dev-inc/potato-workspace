import { PANE_CLAUDE } from '../fixtures';
import { openFileTab } from '../../lib/file-tabs';
import { styledReportBase64 } from '../../components/files/word-look-fixture';
import type { HarnessScenario } from '../types';

// A monthly report Word file (pages, table borders and shading, header and footer) open in a tab beside the chat (dark, 1100 wide).
const s: HarnessScenario = {
  name: 'word-look-dark',
  route: 'cockpit',
  select: PANE_CLAUDE,
  theme: 'dark',
  window: { width: 1100, height: 900 },
  after: async (dom) => {
    (globalThis as { __pmFileBase64?: Record<string, string> }).__pmFileBase64 = { 'report.docx': await styledReportBase64(24) };
    openFileTab(PANE_CLAUDE, 'report.docx');
    await dom.waitFor('.ck-wp-sheet');
    await dom.sleep(1200);
  },
};
export default s;
