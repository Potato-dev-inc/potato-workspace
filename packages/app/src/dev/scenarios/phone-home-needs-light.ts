import { ITEM_HIGH, ITEM_LOW, ITEM_QUESTION } from '../attention-fixtures';
import type { HarnessScenario } from '../types';

// Phone home, light: the place line, one setup chip, and the Needs you cards first with their big answer buttons.
// No open chats, so the app stays on the home instead of opening a chat.
const s: HarnessScenario = {
  name: 'phone-home-needs-light',
  route: 'phone',
  window: { width: 390, height: 844 },
  theme: 'light',
  phonePanes: [],
  phone: { digest: false, attention: { blocking: 3, items: [ITEM_HIGH, ITEM_LOW, ITEM_QUESTION] } },
  after: async (dom) => {
    await dom.waitFor('.ph-head-menu');
    await dom.sleep(500);
    // The What's new sheet opens by itself once: close it.
    Array.from(document.querySelectorAll<HTMLButtonElement>('.ph-btn--primary')).find((b) => b.textContent === 'Done')?.click();
    await dom.sleep(400);
    await dom.waitFor('[data-testid="phone-needs-you"]');
    await dom.sleep(600);
  },
};
export default s;
