import { PANE_CLAUDE } from '../fixtures';
import { openFileTab } from '../../lib/file-tabs';
import { longReportBase64 } from '../../components/files/word-pages-fixture';
import type { HarnessScenario } from '../types';

// A long Word file with no page breaks (pages cut by height, footnotes, a text box, a floating picture, a table with a repeated header row) open in a tab beside the chat (light, 1100 wide).
const s: HarnessScenario = {
  name: 'word-pages-light',
  route: 'cockpit',
  select: PANE_CLAUDE,
  theme: 'light',
  window: { width: 1100, height: 900 },
  after: async (dom) => {
    (globalThis as { __pmFileBase64?: Record<string, string> }).__pmFileBase64 = { 'review.docx': await longReportBase64({ tableRows: 90 }) };
    openFileTab(PANE_CLAUDE, 'review.docx');
    await dom.waitFor('.ck-wp-sheet');
    await dom.sleep(1200);
  },
};
export default s;
