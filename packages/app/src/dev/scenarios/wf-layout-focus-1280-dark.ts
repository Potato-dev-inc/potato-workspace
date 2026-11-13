import { PANE_CODEX } from '../fixtures';
import type { HarnessScenario } from '../types';

// Layout evidence: focus mode: the open pane fills the window.
const s: HarnessScenario = {
  name: 'wf-layout-focus-1280-dark',
  route: 'cockpit',
  select: PANE_CODEX,
  theme: 'dark',
  window: { width: 1280, height: 760 },
  after: async (dom) => {
    await dom.sleep(300);
    dom.key('Enter', { ctrl: true, shift: true });
    await dom.sleep(400);
  },
};
export default s;
