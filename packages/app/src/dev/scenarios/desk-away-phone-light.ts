import { PANE_CODEX } from '../fixtures';
import type { HarnessScenario } from '../types';

// Leaving my desk on the phone: the card in the drawer, with the lengths open.
const s: HarnessScenario = {
  name: 'desk-away-phone-light',
  route: 'phone',
  window: { width: 390, height: 844 },
  theme: 'light',
  phone: { activeTab: PANE_CODEX, digest: false, questions: false, attention: { blocking: 0 }, desk: { away: false, lock_screen: false, phones: 1 } },
  after: async (dom) => {
    await dom.waitFor('.ph-head-menu', 15000);
    await dom.click('.ph-head-menu');
    await dom.waitFor('[data-testid="phone-desk-open"]', 15000);
    await dom.click('[data-testid="phone-desk-open"]');
    await dom.sleep(500);
    document.querySelector('[data-testid="phone-desk"]')?.scrollIntoView({ block: 'center' });
    await dom.sleep(300);
  },
};
export default s;
