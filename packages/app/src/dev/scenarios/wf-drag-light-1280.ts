import type { HarnessScenario } from '../types';
import { SIDEBAR_PANES } from '../fixtures-sidebar';
import { dragMid } from '../wf-drag-shared';

/** A sidebar chat mid-drag over the right half of the work area (light, 1280 wide). */
const s: HarnessScenario = {
  name: 'wf-drag-light-1280',
  route: 'cockpit',
  theme: 'light',
  window: { width: 1280, height: 800 },
  panes: SIDEBAR_PANES,
  after: dragMid,
};
export default s;
