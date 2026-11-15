import { PANE_CODEX } from '../fixtures';
import { PHONE_PANES } from '../phone-fixtures';
import type { HarnessScenario } from '../types';

// An opened artifact (overview page) on the phone at 390 px: it must fill the width.
const s: HarnessScenario = {
  name: 'phone-render-art-overview-390',
  route: 'phone',
  window: { width: 390, height: 844 },
  phonePanes: PHONE_PANES.map((p) => ({ ...p, lane: 'acp' }) as typeof p),
  phone: { activeTab: PANE_CODEX, digest: false, questions: false, attention: { blocking: 0 }, chat: 'render', acp: {} },
  after: async (dom) => {
    await dom.waitFor('.ph-conv');
    await dom.sleep(1200);
    const card = Array.from(document.querySelectorAll<HTMLElement>('button')).filter((b) => b.textContent?.trim() === 'Open')[0];
    card?.click();
    await dom.waitFor('[data-testid="phone-artifact"] iframe');
    await dom.sleep(1200);
  },
};
export default s;
