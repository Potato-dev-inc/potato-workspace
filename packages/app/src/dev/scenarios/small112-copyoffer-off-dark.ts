import type { HarnessScenario } from '../types';
import { PANE_CLAUDE } from '../fixtures';

// The New agent page with the + menu open after "Offer Work on a copy" was turned off: only "Add files" is left.
const s: HarnessScenario = {
  name: 'small112-copyoffer-off-dark',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1100, height: 700 },
  select: PANE_CLAUDE,
  storage: { 'potato.copyOffer.v1': '0' },
  after: async (dom) => {
    await dom.sleep(700);
    await dom.click('button.ck-side-new--primary');
    await dom.waitFor('[data-testid="na-ask"]');
    await dom.sleep(400);
    await dom.click('button[aria-label="Add to your message"]');
    await dom.sleep(500);
  },
};
export default s;
