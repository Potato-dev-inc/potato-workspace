import type { HarnessScenario } from '../types';
import { SIDEBAR_PANES } from '../fixtures-sidebar';
import { dragMid } from '../wf-drag-shared';

/** A sidebar chat mid-drag over the right half of the work area (dark, 900 wide). */
const s: HarnessScenario = {
  name: 'wf-drag-dark-900',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 900, height: 800 },
  panes: SIDEBAR_PANES,
  after: dragMid,
};
export default s;
