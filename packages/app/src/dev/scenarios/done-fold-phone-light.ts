import { PANE_CODEX } from '../fixtures';
import type { HarnessScenario } from '../types';

// Done today in the phone drawer, minimized to one row (the x hides it for the day).
const s: HarnessScenario = {
  name: 'done-fold-phone-light',
  route: 'phone',
  window: { width: 390, height: 844 },
  theme: 'light',
  phone: { activeTab: PANE_CODEX, digest: false, questions: false, attention: { blocking: 0 }, home: true },
  after: async (dom) => {
    await dom.waitFor('.ph-head-menu', 15000);
    await dom.click('.ph-head-menu');
    await dom.waitFor('[data-testid="phone-done-fold"]', 15000);
    await dom.click('[data-testid="phone-done-fold"]');
    await dom.sleep(500);
  },
};
export default s;
