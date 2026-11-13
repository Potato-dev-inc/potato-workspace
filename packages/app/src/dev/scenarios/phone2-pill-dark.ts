import { PANE_CLAUDE, PANE_CODEX } from '../fixtures';
import { ITEM_HIGH, ITEM_LOW, ITEM_MEDIUM } from '../attention-fixtures';
import type { HarnessScenario } from '../types';

// Phone part 2 evidence: pill, dark.
const scenario: HarnessScenario = {
  name: 'phone2-pill-dark',
  route: 'phone',
  window: { width: 390, height: 844 },
  theme: 'dark',
  phone: { activeTab: PANE_CLAUDE, digest: false, questions: false, attention: { blocking: 2, items: [ITEM_LOW, ITEM_MEDIUM] } },
    after: async (dom) => {
      await dom.waitFor('[data-testid="needs-pill"]');
      await dom.sleep(700);
    },
};
export default scenario;
// window: { width: 390, height: 844 } (the registry reads the size from this file)
