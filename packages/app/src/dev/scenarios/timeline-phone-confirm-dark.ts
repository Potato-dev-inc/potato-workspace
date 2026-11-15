import type { HarnessScenario } from '../types';

// Today on the phone. timeline-phone-confirm-dark.
const s: HarnessScenario = {
  name: 'timeline-phone-confirm-dark',
  route: 'phone',
  window: { width: 390, height: 844 },
  theme: 'dark',
  phone: { digest: false, questions: false, attention: { blocking: 0 }, timeline: true },
  after: async (dom) => {
    await dom.waitFor('.ph-head-menu', 15000);
    await dom.click('.ph-head-menu');
    await dom.waitFor('.ph-dsettings', 15000);
    await dom.click('.ph-dsettings');
    await dom.waitFor('[data-testid="phone-menu-today"]', 15000);
    await dom.click('[data-testid="phone-menu-today"]');
    await dom.waitFor('[data-testid="phone-today"] .ph-tl-row', 15000);
    await dom.sleep(700);
    await dom.click('.ph-tl-row');
    await dom.waitFor('[data-testid="phone-point"]', 15000);
    await dom.sleep(700);
    await dom.clickText('button', 'Go back to here');
    await dom.sleep(700);
  },
};
export default s;
