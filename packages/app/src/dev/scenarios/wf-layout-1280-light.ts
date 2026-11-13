import { PANE_CODEX } from '../fixtures';
import type { HarnessScenario } from '../types';

// Layout evidence: a wider sidebar (300) and right panel (380), both remembered.
const s: HarnessScenario = {
  name: 'wf-layout-1280-light',
  route: 'cockpit',
  select: PANE_CODEX,
  theme: 'light',
  window: { width: 1280, height: 760 },
  storage: { 'pm.sidebar.width': '300', 'pm.rail.width': '380' },
};
export default s;
