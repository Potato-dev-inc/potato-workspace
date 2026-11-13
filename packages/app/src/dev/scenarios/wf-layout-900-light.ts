import { PANE_CODEX } from '../fixtures';
import type { HarnessScenario } from '../types';

// Layout evidence: the thin icon strip at 900 px: the right panel fits again beside it.
const s: HarnessScenario = {
  name: 'wf-layout-900-light',
  route: 'cockpit',
  select: PANE_CODEX,
  theme: 'light',
  window: { width: 900, height: 760 },
  storage: { 'pm.sidebar.width': 'strip' },
};
export default s;
