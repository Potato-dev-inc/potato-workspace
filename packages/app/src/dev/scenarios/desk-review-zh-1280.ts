import { PANE_CLAUDE } from '../fixtures';
import { EXAMPLE_TURN_REVIEW } from '../desk-review-fixtures';
import { setLanguagePref } from '../../i18n';
import { keepFile, putBackMark } from '../../lib/turn-review';
import type { HarnessScenario } from '../types';

// The same review in Traditional Chinese (1280 wide).
const s: HarnessScenario = {
  name: 'desk-review-zh-1280',
  route: 'cockpit',
  select: PANE_CLAUDE,
  window: { width: 1280, height: 860 },
  after: async (dom) => {
    setLanguagePref('zh-TW', false);
    await dom.sleep(500);
    await dom.clickText('[role="tab"]', '變更');
    await dom.waitFor('[data-testid="turn-files"] [data-testid="turn-file"]');
    const [a, b, , d] = EXAMPLE_TURN_REVIEW.files;
    keepFile(PANE_CLAUDE, a);
    keepFile(PANE_CLAUDE, b);
    putBackMark(PANE_CLAUDE, d, '9');
    await dom.sleep(500);
  },
};
export default s;
