import type { HarnessScenario } from '../types';

// wiring-phone-whatsnew-light: headless evidence for the 1.1.1 wiring.
const s: HarnessScenario = {
  name: 'wiring-phone-whatsnew-light',
  route: 'phone',
  theme: 'light',
  window: { width: 390, height: 844 },
  phone: { questions: false, digest: false },
  after: async (dom) => {
    await dom.waitFor('[data-testid="phone-whatsnew"]');
    await dom.sleep(700);
  },
};
export default s;
