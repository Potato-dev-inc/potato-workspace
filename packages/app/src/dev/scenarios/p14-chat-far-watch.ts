import { MAC_MINI, NODE_MAC, type RemotePane } from '../devices-fixtures';
import { phoneRenderReply } from '../phone-render-fixture';
import type { HarnessScenario } from '../types';

// P1.4: the same far chat on a PC that lets this PC only watch: the same controls, switched off, each with the one reason.
const PANES: RemotePane[] = [{ id: 'p1', agent_type: 'claude', cwd: '/Users/me/app', status: 'idle', title: 'Build the .dmg', lane: 'acp' }];
const s: HarnessScenario = {
  name: 'p14-chat-far-watch',
  route: 'cockpit',
  window: { width: 1280, height: 900 },
  devices: { devices: [{ ...MAC_MINI, level: 'watch' }], panes: { [NODE_MAC]: PANES }, chats: { p1: phoneRenderReply(Date.now()).items } },
  after: async (dom) => {
    await dom.waitFor(`[data-pane-row="dev:${NODE_MAC}:p1"]`);
    await dom.click(`[data-pane-row="dev:${NODE_MAC}:p1"]`);
    await dom.waitFor('[data-testid="session-chat"]');
    await dom.sleep(800);
  },
};
export default s;
