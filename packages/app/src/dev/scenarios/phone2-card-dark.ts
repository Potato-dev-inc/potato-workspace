import { PANE_CLAUDE, PANE_CODEX } from '../fixtures';
import { ITEM_HIGH, ITEM_LOW, ITEM_MEDIUM } from '../attention-fixtures';
import type { HarnessScenario } from '../types';

// Phone part 2 evidence: card, dark.
const scenario: HarnessScenario = {
  name: 'phone2-card-dark',
  route: 'phone',
  window: { width: 390, height: 844 },
  theme: 'dark',
  phone: { activeTab: PANE_CLAUDE, digest: false, questions: false, attention: { blocking: 1, items: [ITEM_HIGH] } },
    after: async (dom) => {
      await dom.waitFor('[data-testid="phone-ask-card"]');
      await dom.sleep(700);
    },
};
export default scenario;
// window: { width: 390, height: 844 } (the registry reads the size from this file)
