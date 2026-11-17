import type { HarnessScenario } from '../types';
import { REVIEW_DESK_FULL } from '../review-desk-fixtures';

// A short window with the biggest text size and the sidebar ... menu open: the menu must stay fully inside the window.
const s: HarnessScenario = {
  name: 'sidebar-more-menu-tall',
  route: 'cockpit',
  window: { width: 1280, height: 600 },
  reviewDesk: { desk: REVIEW_DESK_FULL },
  after: async (dom) => {
    await dom.sleep(800);
    // The same variable Settings > Text size writes (lib/comfort/root.ts); 1.4 is the largest step.
    document.documentElement.style.setProperty('--ui-scale', '1.4');
    await dom.sleep(400);
    await dom.click('button[aria-label="More"]');
    await dom.sleep(400);
  },
};
export default s;
