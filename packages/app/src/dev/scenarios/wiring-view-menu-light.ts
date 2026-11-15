import { PANE_CLAUDE } from '../fixtures';
import type { HarnessScenario } from '../types';

// wiring-view-menu-light: headless evidence for the 1.1.1 wiring.
const s: HarnessScenario = {
  name: 'wiring-view-menu-light',
  route: 'cockpit',
  select: PANE_CLAUDE,
  theme: 'light',
  window: { width: 1280, height: 800 },
  after: async (dom) => {
    const reg = await import('../../whatsnew/registry');
    await dom.clickText('button', 'Chat');
    await dom.waitFor('.ck-chat-mode-pill');
    reg.runAction('chat.viewMenu');
    await dom.waitFor('.ck-chat-mode-menu');
    await dom.sleep(400);
  },
};
export default s;
