import { MAC_MINI, NODE_MAC, type RemotePane } from '../devices-fixtures';
import { phoneRenderReply } from '../phone-render-fixture';
import type { HarnessScenario } from '../types';

// P1.4: a chat on ANOTHER PC (Full there), opened from the one Projects list. The normal chat screen, in the host of that PC. Same
// transcript and settings as `p14-chat-local`; the only differences are the small PC badge and the project's badge in the sidebar.
const PANES: RemotePane[] = [{ id: 'p1', agent_type: 'claude', cwd: '/Users/me/app', status: 'idle', title: 'Build the .dmg', lane: 'acp' }];
const s: HarnessScenario = {
  name: 'p14-chat-far',
  route: 'cockpit',
  window: { width: 1280, height: 900 },
  devices: { devices: [{ ...MAC_MINI, level: 'full' }], panes: { [NODE_MAC]: PANES }, chats: { p1: phoneRenderReply(Date.now()).items } },
  after: async (dom) => {
    await dom.waitFor(`[data-pane-row="dev:${NODE_MAC}:p1"]`);
    await dom.click(`[data-pane-row="dev:${NODE_MAC}:p1"]`);
    await dom.waitFor('[data-testid="session-chat"]');
    await dom.waitFor('[data-chip-id="model"]');
    await dom.sleep(800);
  },
};
export default s;
