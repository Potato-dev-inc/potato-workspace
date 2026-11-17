import { PANE_CODEX } from '../fixtures';
import type { HarnessScenario } from '../types';

// Done today in the phone drawer, open, with the minimize chevron and the hide x.
const s: HarnessScenario = {
  name: 'done-open-phone-light',
  route: 'phone',
  window: { width: 390, height: 844 },
  theme: 'light',
  phone: { activeTab: PANE_CODEX, digest: false, questions: false, attention: { blocking: 0 }, home: true },
  after: async (dom) => {
    await dom.waitFor('.ph-head-menu', 15000);
    await dom.click('.ph-head-menu');
    await dom.waitFor('[data-testid="phone-done-fold"]', 15000);
    await dom.sleep(500);
  },
};
export default s;
