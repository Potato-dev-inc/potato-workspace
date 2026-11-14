import { PANE_CLAUDE } from '../fixtures';
import { EXAMPLE_TURN_REVIEW } from '../desk-review-fixtures';
import { keepFile, putBackMark } from '../../lib/turn-review';
import type { HarnessScenario } from '../types';

// Review the last turn file by file in the Changes tab of a pane with a separate copy: two files kept, one put back, one opened with its changes
// (1280 wide; PM_EVIDENCE_THEME picks dark or light).
const s: HarnessScenario = {
  name: 'desk-review-1280',
  route: 'cockpit',
  select: PANE_CLAUDE,
  window: { width: 1280, height: 860 },
  after: async (dom) => {
    await dom.sleep(500);
    await dom.clickText('[role="tab"]', 'Changes');
    await dom.waitFor('[data-testid="turn-files"] [data-testid="turn-file"]');
    const [a, b, , d] = EXAMPLE_TURN_REVIEW.files;
    keepFile(PANE_CLAUDE, a);
    keepFile(PANE_CLAUDE, b);
    putBackMark(PANE_CLAUDE, d, '9');
    await dom.sleep(200);
    document.querySelectorAll<HTMLElement>('[data-tf-row]')[1]?.click();
    await dom.waitFor('[data-testid="file-diff"] [role="option"]');
    await dom.sleep(500);
  },
};
export default s;
