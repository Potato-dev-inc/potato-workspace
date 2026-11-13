import type { HarnessScenario } from '../types';
import { sidebarDrag } from '../dndShots';

// A chat dragged up in the sidebar: the thin line shows the spot, and the Pinned drop box shows at the top (drag in progress, light, 1280).
const s: HarnessScenario = {
  name: 'dnd-sidebar-light-1280',
  route: 'cockpit',
  theme: 'light',
  window: { width: 1280, height: 760 },
  after: sidebarDrag,
};
export default s;
