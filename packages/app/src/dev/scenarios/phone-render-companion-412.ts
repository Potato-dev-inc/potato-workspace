import { PHONE_PANES } from '../phone-fixtures';
import type { HarnessScenario } from '../types';

// The companion home on the phone at 412 px: nothing may overlap, Sleep is in the header menu, no model pill.
const s: HarnessScenario = {
  name: 'phone-render-companion-412',
  route: 'phone',
  window: { width: 412, height: 844 },
  phonePanes: PHONE_PANES.map((p) => ({ ...p, lane: 'acp' }) as typeof p),
  phone: { digest: false, questions: false, attention: { blocking: 0 }, companion: true, acp: {} },
  after: async (dom) => {
    await dom.waitFor('.ph-conv');
    await dom.sleep(900);
    await dom.click('.ph-head-menu');
    await dom.waitFor('.ph-drawer');
    const row = Array.from(document.querySelectorAll<HTMLElement>('.ph-drawer button')).find((b) => b.textContent?.includes('Mochi'));
    row?.click();
    await dom.waitFor('.ph-comp');
    await dom.sleep(1500);
  },
};
export default s;
