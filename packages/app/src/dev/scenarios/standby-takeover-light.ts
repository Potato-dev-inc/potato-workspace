import type { HarnessScenario } from '../types';
import { SIDEBAR_PANES } from '../fixtures-sidebar';

// The chat the person was using a standby in: an agent took it, the banner says so and the box waits.
const s: HarnessScenario = {
  name: 'standby-takeover-light',
  route: 'cockpit',
  theme: 'light',
  window: { width: 1280, height: 900 },
  panes: SIDEBAR_PANES,
  select: 'sb-notes',
  storage: { 'pm.sidebar.groupBy': 'status' },
  after: async (dom) => {
    await dom.sleep(800);
    const chat = [...document.querySelectorAll<HTMLElement>('button, [role="tab"]')].find((b) => b.textContent?.trim() === 'Chat');
    chat?.click();
    await dom.sleep(1500);
  },
};
export default s;
