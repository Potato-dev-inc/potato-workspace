import { PANE_CODEX } from '../fixtures';
import { PHONE_PANES } from '../phone-fixtures';
import type { HarnessScenario } from '../types';

// "from Ren's PC" / "from OPPO Reno13" under messages, and (tookBack) on the phone (light).
const s: HarnessScenario = {
  name: 'sent-from-phone-tookback-light',
  route: 'phone',
  window: { width: 390, height: 844 },
  theme: 'light',
  phonePanes: PHONE_PANES.map((p) => ({ ...p, lane: 'acp' }) as typeof p),
  phone: { activeTab: PANE_CODEX, digest: false, questions: false, attention: { blocking: 0 }, acp: {}, sentFrom: 'tookBack' },
  after: async (dom) => {
    await dom.waitFor('.ph-conv');
    await dom.waitFor('[data-testid="phone-sent-from"]');
    await dom.waitFor('[data-testid="phone-took-back"]');
    await dom.sleep(600);
  },
};
export default s;
