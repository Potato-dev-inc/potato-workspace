import { MAC_MINI, MAC_PANES, NODE_MAC } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// The New agent page on a PC that lets this PC watch only (dark): Start is off, with the reason, before anything is typed.
const s: HarnessScenario = {
  name: 'devices-newagent-watch-only-dark',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1280, height: 800 },
  devices: { devices: [{ ...MAC_MINI, level: 'watch' }], panes: { [NODE_MAC]: MAC_PANES } },
  after: async (dom) => {
    await dom.sleep(700);
    await dom.click('button.ck-side-new--primary');
    await dom.waitFor('.ck-na-row [data-testid="where-pill"]');
    await dom.click('[data-testid="where-pill"]');
    await dom.waitFor('.dev-where-menu');
    await dom.click(`[data-testid="where-${NODE_MAC}"]`);
    await dom.waitFor('[data-testid="na-on-device"]');
    await dom.sleep(400);
  },
};
export default s;
