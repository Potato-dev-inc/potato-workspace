import { PANE_OPENCODE } from '../fixtures';
import type { HarnessScenario } from '../types';
import { withRailData } from './right-panel-items';

// The right panel, 1.1.1 look (empty): flat sections under a sticky top line. Run with PM_EVIDENCE_THEME=dark|light|dim.
const s: HarnessScenario = {
  name: 'right-panel-empty',
  route: 'cockpit',
  select: PANE_OPENCODE,
  window: { width: 1280, height: 860 },
  after: async (dom) => {
    await dom.waitFor('[data-testid="session-rail"]');
    await dom.sleep(900);
  },
};
export default s;
