import { PANE_CODEX } from '../fixtures';
import { PHONE_PANES } from '../phone-fixtures';
import type { HarnessScenario } from '../types';

// The plan bar on the phone chat, and the waiting messages with Edit and Remove. light.
const s: HarnessScenario = {
  name: 'phone-plan-progress-light',
  route: 'phone',
  window: { width: 390, height: 844 },
  theme: 'light',
  phonePanes: PHONE_PANES.map((p) => ({ ...p, lane: 'acp' }) as typeof p),
  phone: { activeTab: PANE_CODEX, chat: 'plan', digest: false, questions: false, attention: { blocking: 0 } },
  after: async (dom) => {
    await dom.waitFor('[data-testid="plan-bar"]');
    await dom.sleep(800);
  },
};
export default s;
