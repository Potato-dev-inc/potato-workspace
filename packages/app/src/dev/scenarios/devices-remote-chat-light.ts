import { MAC_MINI, MAC_PANES, NODE_MAC } from '../devices-fixtures';
import { phoneRenderReply } from '../phone-render-fixture';
import type { HarnessScenario } from '../types';

// A chat running on the Mac mini, open in the main area (light): the box, the result bar and the icons must be styled like a local chat.
const s: HarnessScenario = {
  name: 'devices-remote-chat-light',
  route: 'cockpit',
  window: { width: 1280, height: 900 },
  theme: 'light',
  devices: {
    devices: [MAC_MINI],
    panes: { [NODE_MAC]: MAC_PANES },
    chats: { p1: phoneRenderReply(Date.now()).items },
  },
  after: async (dom) => {
    await dom.waitFor(`[data-pane-row="dev:${NODE_MAC}:p1"]`);
    await dom.click(`[data-pane-row="dev:${NODE_MAC}:p1"]`);
    await dom.waitFor('[data-testid="session-chat"]');
    await dom.sleep(500);
  },
};
export default s;
