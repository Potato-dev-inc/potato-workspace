import { PANE_CODEX } from '../fixtures';
import type { HarnessScenario } from '../types';
import { withChatItems } from './pane-polish-chat-items';

// The Remote control card in the session rail (phones paired, one switched down to watch only).
const s: HarnessScenario = {
  name: 'wf-remote-light-900',
  route: 'cockpit',
  theme: 'light',
  select: PANE_CODEX,
  window: { width: 900, height: 760 },
  after: async (dom) => {
    withChatItems();
    await dom.clickText('[role="tab"]', 'Chat');
    if (!document.querySelector('[data-testid="rail-remote"]')) await dom.click('button[aria-label="Show session details"]');
    await dom.waitFor('[data-testid="rail-remote"]');
    await dom.clickText('[data-testid="rail-remote"] [role="radio"]', 'Watch');
    await dom.sleep(400);
  },
};
export default s;
