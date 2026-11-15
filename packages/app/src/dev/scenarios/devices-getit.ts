import { MAC_FILES, MAC_MINI, MAC_PANES, NODE_MAC } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// A chat on the Mac mini whose last reply names a result file: the Get it card under the chat.
const now = Math.floor(Date.now() / 1000);
const s: HarnessScenario = {
  name: 'devices-getit',
  route: 'cockpit',
  window: { width: 1280, height: 900 },
  devices: {
    devices: [{ ...MAC_MINI, lets_files: true }],
    panes: { [NODE_MAC]: MAC_PANES },
    files: MAC_FILES,
    chats: {
      p1: [
        { kind: 'user', id: 'u1', at: now - 90, text: 'Build the .dmg and tell me where it is.' },
        { kind: 'assistant', id: 'a1', at: now - 30, text: 'The build finished. The installer is ready.\n\npotato-result: build/app.dmg', model: null, finalAnswer: true },
      ],
    },
  },
  after: async (dom) => {
    await dom.waitFor(`[data-pane-row="dev:${NODE_MAC}:p1"]`);
    await dom.click(`[data-pane-row="dev:${NODE_MAC}:p1"]`);
    await dom.waitFor('[data-testid="get-it-card"]');
    await dom.sleep(500);
  },
};
export default s;
