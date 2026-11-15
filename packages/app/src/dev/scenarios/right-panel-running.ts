import { PANE_CODEX } from '../fixtures';
import type { HarnessScenario } from '../types';
import { withRailData } from './right-panel-items';

// The right panel, 1.1.1 look (running): flat sections under a sticky top line. Run with PM_EVIDENCE_THEME=dark|light|dim.
const s: HarnessScenario = {
  name: 'right-panel-running',
  route: 'cockpit',
  select: PANE_CODEX,
  window: { width: 1280, height: 860 },
  after: async (dom) => {
    withRailData(PANE_CODEX);
    // Close and open the panel once so it reads the chat the helper now answers with.
    dom.key(']');
    await dom.sleep(300);
    dom.key(']');
    await dom.waitFor('[data-testid="session-rail"]');
    await dom.sleep(900);
  },
};
export default s;
