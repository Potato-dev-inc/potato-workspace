import { ITEM_HIGH, QUEUE_PANES } from '../attention-fixtures';
import { PANE_CLAUDE } from '../fixtures';
import type { HarnessScenario } from '../types';

// Phone chat: a high-risk ask of the open chat opens as a full card by itself; the exact step is folded.
const s: HarnessScenario = {
  name: 'phone-risky-ask',
  route: 'phone',
  window: { width: 390, height: 844 },
  phonePanes: QUEUE_PANES.map((p) => ({ ...p, lane: 'acp' }) as typeof p),
  phone: { activeTab: PANE_CLAUDE, digest: false, questions: false, attention: { blocking: 1, items: [ITEM_HIGH] }, chat: 'live', acp: { busy: false } },
  after: async (dom) => {
    await dom.waitFor('[data-testid="risky-card"]');
    await dom.sleep(800);
  },
};
export default s;
