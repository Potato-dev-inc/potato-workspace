import { PANE_CLAUDE, PANE_CODEX } from '../fixtures';
import { PHONE_PANES } from '../phone-fixtures';
import { ITEM_HIGH, ITEM_LOW, ITEM_MEDIUM } from '../attention-fixtures';
import type { HarnessScenario } from '../types';

// Phone part 2 evidence: watchonly, light.
const scenario: HarnessScenario = {
  name: 'phone2-watchonly-light',
  route: 'phone',
  window: { width: 390, height: 844 },
  theme: 'light',
  // Only Billing tests is the chat of this shot: the others are idle, so the app does not land on a chat that needs you.
  phonePanes: PHONE_PANES.map((p) => (p.id === PANE_CODEX ? p : { ...p, status: 'idle' as const })),
  phone: { activeTab: PANE_CODEX, digest: false, questions: false, attention: { blocking: 0 }, rules: { [PANE_CODEX]: { remote: true, level: 'watch' } } },
    after: async (dom) => {
      await dom.waitFor('[data-testid="phone-no-control"]');
      await dom.sleep(600);
    },
};
export default scenario;
// window: { width: 390, height: 844 } (the registry reads the size from this file)
