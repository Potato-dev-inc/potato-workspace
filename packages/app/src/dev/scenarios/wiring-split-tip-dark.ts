import { PANE_CLAUDE } from '../fixtures';
import type { HarnessScenario } from '../types';

// wiring-split-tip-dark: headless evidence for the 1.1.1 wiring.
const s: HarnessScenario = {
  name: 'wiring-split-tip-dark',
  route: 'cockpit',
  select: PANE_CLAUDE,
  theme: 'dark',
  window: { width: 1280, height: 800 },
  after: async (dom) => {
    const reg = await import('../../whatsnew/registry');
    await dom.waitFor('.ck-main');
    await dom.sleep(500);
    // The tip lasts a few seconds: keep asking so it is on screen whenever the shot is taken.
    window.setInterval(() => reg.runAction('split.hint'), 2000);
    reg.runAction('split.hint');
    await dom.waitFor('[data-testid="work-drop-tip"]');
    await dom.sleep(500);
  },
};
export default s;
