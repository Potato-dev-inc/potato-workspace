import { PANE_CODEX, PANE_OPENCODE } from '../fixtures';
import { PHONE_PANES } from '../phone-fixtures';
import type { HarnessScenario } from '../types';

// The drawer at 412 px: a helper another agent started sits one step in under its parent, with a guide line.
const s: HarnessScenario = {
  name: 'phone-render-drawer-412',
  route: 'phone',
  window: { width: 412, height: 844 },
  phonePanes: PHONE_PANES.map((p) => ({ ...p, lane: 'acp', ...(p.id === PANE_OPENCODE ? { parent_pane_id: PANE_CODEX, cwd: PHONE_PANES.find((q) => q.id === PANE_CODEX)!.cwd, title: 'Review the last commit' } : {}) }) as typeof p),
  phone: { activeTab: PANE_CODEX, digest: false, questions: false, attention: { blocking: 0 }, acp: {} },
  after: async (dom) => {
    await dom.waitFor('.ph-conv');
    await dom.sleep(900);
    await dom.click('.ph-head-menu');
    await dom.waitFor('.ph-drawer');
    await dom.sleep(500);
  },
};
export default s;
