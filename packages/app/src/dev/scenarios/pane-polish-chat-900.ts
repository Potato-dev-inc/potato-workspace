import { PANE_CODEX } from '../fixtures';
import type { HarnessScenario } from '../types';
import { withChatItems } from './pane-polish-chat-items';

// The chat pane header: one row (name, Chat tabs, then Ask aside, Summary/Normal/Verbose, Share, state, More).
const s: HarnessScenario = {
  name: 'pane-polish-chat-900',
  route: 'cockpit',
  select: PANE_CODEX,
  window: { width: 900, height: 720 },
  after: async (dom) => {
    withChatItems();
    await dom.clickText('[role="tab"]', 'Chat');
    await dom.waitFor('[data-testid="pane-head-chat"]');
    await dom.sleep(500);
  },
};
export default s;
