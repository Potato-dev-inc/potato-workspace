import type { HarnessScenario } from '../types';
import { adoptDrag } from '../dndShots';

// An agent dragged onto the middle of another agent's row in the sidebar: the row shows "Make helper of ..." (drag in progress, dark, 1280).
const s: HarnessScenario = {
  name: 'adopt-drag-dark-1280',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1280, height: 760 },
  after: adoptDrag,
};
export default s;
