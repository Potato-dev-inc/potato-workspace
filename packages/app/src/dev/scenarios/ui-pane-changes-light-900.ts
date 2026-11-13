import type { HarnessScenario } from '../types';
import { PANE_CLAUDE } from '../fixtures';

// Evidence for the pane header, pane tabs, plain right panel and Changes list (changes-light-900).
const s: HarnessScenario = {
  name: 'ui-pane-changes-light-900',
  route: 'cockpit',
  theme: 'light',
  window: { width: 900, height: 760 },
  select: PANE_CLAUDE,
  after: async (dom) => {
    await dom.sleep(500);
    await dom.clickText('[role="tab"]', 'Changes'); await dom.waitFor('.ck-changes-file');
    await dom.sleep(500);
  },
};
export default s;
