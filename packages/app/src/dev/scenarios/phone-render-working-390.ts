import { PANE_CODEX } from '../fixtures';
import { PHONE_PANES } from '../phone-fixtures';
import type { HarnessScenario } from '../types';

// While the agent works at 390 px: one Stop (the round button in the box); the line above only says Working.
const s: HarnessScenario = {
  name: 'phone-render-working-390',
  route: 'phone',
  window: { width: 390, height: 844 },
  phonePanes: PHONE_PANES.map((p) => ({ ...p, lane: 'acp' }) as typeof p),
  phone: { activeTab: PANE_CODEX, digest: false, questions: false, attention: { blocking: 0 }, chat: 'live', acp: { busy: true } },
  after: async (dom) => {
    await dom.waitFor('.ph-conv');
    await dom.sleep(1800);
  },
};
export default s;
