import { MAC_MINI, NODE_MAC, type RemotePane } from '../devices-fixtures';
import { phoneRenderReply } from '../phone-render-fixture';
import type { HarnessScenario } from '../types';

// P1.7: the far chat's message box works like the local one. A message typed here goes to the far PC as the pane_message_send row, and it
// comes back into the feed as the far PC's session-chat-items frame (no polling). Full there (the person's own PC).
const PANES: RemotePane[] = [{ id: 'p1', agent_type: 'claude', cwd: '/Users/me/app', status: 'idle', title: 'Build the .dmg', lane: 'acp' }];
const s: HarnessScenario = {
  name: 'p17-chat-far-sent',
  route: 'cockpit',
  window: { width: 1280, height: 900 },
  devices: { devices: [{ ...MAC_MINI, level: 'full' }], panes: { [NODE_MAC]: PANES }, chats: { p1: phoneRenderReply(Date.now()).items } },
  after: async (dom) => {
    await dom.waitFor(`[data-pane-row="dev:${NODE_MAC}:p1"]`);
    await dom.click(`[data-pane-row="dev:${NODE_MAC}:p1"]`);
    await dom.waitFor('[data-testid="session-chat"]');
    const box = (await dom.waitFor('textarea[aria-label="Message to the agent"]')) as HTMLTextAreaElement | null;
    if (box) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(box, 'Run the tests again and tell me what fails.');
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await dom.sleep(200);
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    }
    await dom.sleep(1200);
  },
};
export default s;
