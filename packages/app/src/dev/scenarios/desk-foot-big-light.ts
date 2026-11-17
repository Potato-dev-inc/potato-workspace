import { PANE_CODEX } from '../fixtures';
import { setPhoneTextSize } from '../../lib/phone-text-size';
import type { HarnessScenario } from '../types';

// Leave my desk as a button in the drawer's bottom bar at the biggest text size (closed, so the bar itself is visible).
const s: HarnessScenario = {
  name: 'desk-foot-big-light',
  route: 'phone',
  window: { width: 390, height: 844 },
  theme: 'light',
  phone: { activeTab: PANE_CODEX, digest: false, questions: false, attention: { blocking: 0 }, desk: { away: false, lock_screen: false, phones: 1 } },
  after: async (dom) => {
    setPhoneTextSize('large');
    await dom.waitFor('.ph-head-menu', 15000);
    await dom.click('.ph-head-menu');
    await dom.waitFor('[data-testid="phone-desk-foot"]', 15000);
    await dom.sleep(500);
  },
};
export default s;
