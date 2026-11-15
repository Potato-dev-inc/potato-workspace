import { PANE_CLAUDE } from '../fixtures';
import { exampleUsage } from '../usage-fixtures';
import type { HarnessScenario } from '../types';

// wiring-usage-open-dark: headless evidence for the 1.1.1 wiring.
const s: HarnessScenario = {
  name: 'wiring-usage-open-dark',
  route: 'cockpit',
  select: PANE_CLAUDE,
  theme: 'dark',
  usage: exampleUsage(),
  window: { width: 1280, height: 800 },
  after: async (dom) => {
    const reg = await import('../../whatsnew/registry');
    await dom.waitFor('.ck-statusbar');
    await dom.sleep(500);
    reg.runAction('usage.open');
    await dom.waitFor('.ck-usage-pop, .ck-statusbar [aria-expanded="true"]');
    await dom.sleep(500);
  },
};
export default s;
