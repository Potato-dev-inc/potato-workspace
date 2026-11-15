import { MAC_MINI, MAC_PANES, NODE_MAC, WORK_LAPTOP } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// The full New agent page with the Where pill in the composer row (mac, dark). "open": the list (This PC, Mac mini, the offline laptop
// greyed). "mac": the Mac mini picked, so the project and agents are the Mac's own, the pill still first.
const s: HarnessScenario = {
  name: 'devices-newagent-where-mac-dark',
  route: 'cockpit',
  theme: 'dark',
  window: { width: 1280, height: 800 },
  devices: { devices: [MAC_MINI, WORK_LAPTOP], panes: { [NODE_MAC]: MAC_PANES } },
  after: async (dom) => {
    await dom.sleep(700);
    await dom.click('button.ck-side-new--primary');
    await dom.waitFor('[data-testid="na-ask"]');
    await dom.waitFor('.ck-na-row [data-testid="where-pill"]');
    await dom.click('[data-testid="where-pill"]');
    await dom.waitFor('.dev-where-menu');
    await dom.click(`[data-testid="where-${NODE_MAC}"]`);
    await dom.waitFor('[data-testid="phone-new-chat"]');
    await dom.waitFor('[data-testid="nc-agent-tile"]');
    await dom.sleep(400);
  },
};
export default s;
