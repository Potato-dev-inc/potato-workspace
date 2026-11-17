import { ITEM_LOW, QUEUE_PANES } from '../attention-fixtures';
import { PANE_CODEX } from '../fixtures';
import type { HarnessScenario } from '../types';

// Phone chat: a low-risk ask grows out of the message box (the dock), and Allow once leaves one line in the chat.
const s: HarnessScenario = {
  name: 'phone-dock-ask',
  route: 'phone',
  window: { width: 390, height: 844 },
  phonePanes: QUEUE_PANES.map((p) => ({ ...p, lane: 'acp' }) as typeof p),
  phone: { activeTab: PANE_CODEX, digest: false, questions: false, attention: { blocking: 0, items: [ITEM_LOW] }, chat: 'live', acp: { busy: false } },
  after: async (dom) => {
    await dom.waitFor('.ph-conv');
    await dom.sleep(1500);
  },
};
export default s;
