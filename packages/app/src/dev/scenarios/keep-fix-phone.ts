import { PANE_CLAUDE } from '../fixtures';
import type { HarnessScenario } from '../types';
import { withRailData } from './right-panel-items';

// Keep fix evidence (phone). Run with PM_EVIDENCE_THEME=dark|light|dim.
const s: HarnessScenario = {
  name: 'keep-fix-phone',
  route: 'cockpit',
  select: PANE_CLAUDE,
  window: { width: 1280, height: 860 },
  after: async (dom) => {
    withRailData(PANE_CLAUDE);
    dom.key(']');
    await dom.sleep(300);
    dom.key(']');
    await dom.waitFor('[data-testid="session-rail"]');
    await dom.sleep(900);
    await dom.clickText('button', 'Phone control');
    await dom.sleep(500);
  },
};
export default s;
