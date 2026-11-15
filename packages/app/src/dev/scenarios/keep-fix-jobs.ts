import { PANE_CODEX } from '../fixtures';
import type { HarnessScenario } from '../types';
import { withRailData } from './right-panel-items';

// Keep fix evidence (jobs). Run with PM_EVIDENCE_THEME=dark|light|dim.
const s: HarnessScenario = {
  name: 'keep-fix-jobs',
  route: 'cockpit',
  select: PANE_CODEX,
  window: { width: 1280, height: 860 },
  after: async (dom) => {
    withRailData(PANE_CODEX);
    dom.key(']');
    await dom.sleep(300);
    dom.key(']');
    await dom.waitFor('[data-testid="session-rail"]');
    await dom.sleep(900);
    await dom.click('[data-testid="jobs-chip"]');
    await dom.sleep(600);
  },
};
export default s;
