import { PANE_CODEX } from '../fixtures';
import type { HarnessScenario } from '../types';

// The message rail on the phone (N5-19), light: the rich fixture chat, the pointer (a thumb) on one dash.
const s: HarnessScenario = {
  name: 'message-rail-phone-light',
  route: 'phone',
  window: { width: 390, height: 844 },
  theme: 'light',
  phone: { activeTab: PANE_CODEX, chat: 'rich', digest: false, questions: false, attention: { blocking: 0 } },
  after: async (dom) => {
    await dom.waitFor('.ph-conv', 15000);
    await dom.waitFor('[data-testid="message-rail"]', 15000);
    await dom.sleep(500);
    const rail = document.querySelector<HTMLElement>('[data-testid="message-rail"]')!;
    const dashes = rail.querySelectorAll<HTMLElement>('[data-testid="message-rail-dash"]');
    const dash = dashes[Math.min(2, dashes.length - 1)];
    const top = rail.getBoundingClientRect().top + parseFloat(dash.style.top) + 1;
    rail.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientY: top }));
    await dom.sleep(500);
  },
};
export default s;
