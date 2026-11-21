import { phoneRenderReply } from '../phone-render-fixture';
import type { HarnessScenario } from '../types';

// P1.4: a chat on THIS PC. Compare with `p14-chat-far`: the same transcript and settings, the same chrome.
const s: HarnessScenario = {
  name: 'p14-chat-local',
  route: 'cockpit',
  window: { width: 1280, height: 900 },
  select: 'p14-local',
  localAcpChat: { paneId: 'p14-local', title: 'Build the .dmg', cwd: 'C:\Users\dev\work\app', items: phoneRenderReply(Date.now()).items },
  after: async (dom) => {
    await dom.waitFor('[data-testid="session-chat"]');
    await dom.waitFor('[data-chip-id="model"]');
    await dom.sleep(600);
  },
};
export default s;
