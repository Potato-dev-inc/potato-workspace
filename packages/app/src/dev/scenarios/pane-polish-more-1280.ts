import { PANE_CODEX } from '../fixtures';
import type { HarnessScenario } from '../types';
import { withChatItems } from './pane-polish-chat-items';

// The pane header's More menu open: it floats above the pane and the right rail, nothing is cut.
const s: HarnessScenario = {
  name: 'pane-polish-more-1280',
  route: 'cockpit',
  select: PANE_CODEX,
  window: { width: 1280, height: 720 },
  after: async (dom) => {
    withChatItems();
    await dom.clickText('[role="tab"]', 'Chat');
    await dom.waitFor('[data-testid="pane-head-chat"]');
    await dom.sleep(300);
    await dom.clickText('.ck-pane-head button[aria-haspopup="menu"]', '⋯');
    await dom.waitFor('.ck-menu--float[role="menu"]');
    await dom.sleep(400);
  },
};
export default s;
