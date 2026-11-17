import { PANE_CODEX } from '../fixtures';
import type { HarnessScenario } from '../types';

// Leaving my desk on the phone: the button in the drawer's bottom bar, with its panel open.
const s: HarnessScenario = {
  name: 'desk-away-phone-dark',
  route: 'phone',
  window: { width: 390, height: 844 },
  theme: 'dark',
  phone: { activeTab: PANE_CODEX, digest: false, questions: false, attention: { blocking: 0 }, desk: { away: false, lock_screen: false, phones: 1 } },
  after: async (dom) => {
    await dom.waitFor('.ph-head-menu', 15000);
    await dom.click('.ph-head-menu');
    await dom.waitFor('[data-testid="phone-desk-foot"]', 15000);
    await dom.click('[data-testid="phone-desk-foot"]');
    await dom.sleep(500);
    document.querySelector('[data-testid="phone-desk"]')?.scrollIntoView({ block: 'center' });
    await dom.sleep(300);
  },
};
export default s;
