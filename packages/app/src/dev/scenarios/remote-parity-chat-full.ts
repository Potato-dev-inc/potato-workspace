import { MAC_MINI, NODE_MAC, type RemotePane } from '../devices-fixtures';
import { phoneRenderReply } from '../phone-render-fixture';
import type { HarnessScenario } from '../types';

// A chat on another PC that lets this PC work there (Full): the View switch, Close chat, and the model chip as a real list.
const PANES: RemotePane[] = [{ id: 'p1', agent_type: 'claude', cwd: '/Users/me/app', status: 'idle', title: 'Build the .dmg', lane: 'acp', model: 'Sonnet 5.5', mode: 'asks', branch: 'main' }];
const s: HarnessScenario = {
  name: 'remote-parity-chat-full',
  route: 'cockpit',
  window: { width: 1280, height: 900 },
  devices: { devices: [{ ...MAC_MINI, level: 'full' }], panes: { [NODE_MAC]: PANES }, chats: { p1: phoneRenderReply(Date.now()).items } },
  after: async (dom) => {
    await dom.waitFor(`[data-pane-row="dev:${NODE_MAC}:p1"]`);
    await dom.click(`[data-pane-row="dev:${NODE_MAC}:p1"]`);
    await dom.waitFor('[data-chip-id="model"] button');
    await dom.sleep(500);
    await dom.click('[data-chip-id="model"] button');
    await dom.sleep(400);
  },
};
export default s;
