import type { HarnessScenario } from '../types';
import { REVIEW_DESK_FULL } from '../review-desk-fixtures';

// Something waits in Review: the sidebar footer reads "Review · N" next to the icon in a wide window.
const s: HarnessScenario = {
  name: 'sidebar-review-count',
  route: 'cockpit',
  window: { width: 1440, height: 900 },
  reviewDesk: { desk: REVIEW_DESK_FULL },
  after: async (dom) => {
    await dom.sleep(800);
  },
};
export default s;
