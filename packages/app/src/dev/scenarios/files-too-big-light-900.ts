import { PANE_CLAUDE } from '../fixtures';
import { openFileTab } from '../../lib/file-tabs';
import type { HarnessScenario } from '../types';

// A Word file over the 500 MB limit: the message and the two ways out.
const s: HarnessScenario = {
  name: 'files-too-big-light-900',
  route: 'cockpit',
  select: PANE_CLAUDE,
  theme: 'light',
  window: { width: 900, height: 800 },
  after: async (dom) => {
    (globalThis as unknown as { __pmBigFile?: unknown }).__pmBigFile = { url: '', size: 612 * 1024 * 1024, tooLarge: true };
    openFileTab(PANE_CLAUDE, 'big-report.docx');
    await dom.waitFor('[data-testid="file-too-large"]');
    await dom.sleep(600);
  },
};
export default s;
