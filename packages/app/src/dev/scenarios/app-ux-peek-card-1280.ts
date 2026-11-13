import type { HarnessScenario } from '../types';
import { PANE_CLAUDE } from '../fixtures';

// The peek card: the pointer rests on an agent row in the sidebar.
const s: HarnessScenario = {
  name: 'app-ux-peek-card-1280',
  route: 'cockpit',
  select: PANE_CLAUDE,
  window: { width: 1280, height: 820 },
  after: async (dom) => {
    await dom.sleep(800);
    const row = document.querySelector('[data-pane-row="' + PANE_CLAUDE + '"]');
    row?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    await dom.waitFor('[data-testid="peek-card"]', 3000);
    await dom.sleep(400);
  },
};
export default s;
