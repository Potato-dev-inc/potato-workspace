import type { HarnessScenario } from '../types';
import { PANE_CLAUDE } from '../fixtures';

// Evidence for the pane header, pane tabs, plain right panel and Changes list (changes-dark-1280).
const s: HarnessScenario = {
  name: 'ui-pane-changes-dark-1280',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1280, height: 760 },
  select: PANE_CLAUDE,
  after: async (dom) => {
    await dom.sleep(500);
    await dom.clickText('[role="tab"]', 'Changes'); await dom.waitFor('.ck-changes-file');
    await dom.sleep(500);
  },
};
export default s;
