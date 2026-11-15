import { PANE_CODEX } from '../fixtures';
import { PHONE_PANES } from '../phone-fixtures';
import type { HarnessScenario } from '../types';

// The phone chat with a permission line, artifact cards and folded steps (the giant triangle bug), at 412 px.
const s: HarnessScenario = {
  name: 'phone-render-chat-412',
  route: 'phone',
  window: { width: 412, height: 844 },
  phonePanes: PHONE_PANES.map((p) => ({ ...p, lane: 'acp' }) as typeof p),
  phone: { activeTab: PANE_CODEX, digest: false, questions: false, attention: { blocking: 0 }, chat: 'render', acp: {} },
  after: async (dom) => {
    await dom.waitFor('.ph-conv');
    await dom.sleep(1500);
  },
};
export default s;
