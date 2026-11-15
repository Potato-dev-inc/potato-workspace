import { MAC_MINI, MAC_PANES, NODE_MAC } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// The sidebar with a "Mac mini · 2" group under This PC: its chat and its terminal, each with the small device mark.
const s: HarnessScenario = {
  name: 'devices-sidebar',
  route: 'cockpit',
  window: { width: 1280, height: 900 },
  devices: { devices: [MAC_MINI], panes: { [NODE_MAC]: MAC_PANES } },
  after: async (dom) => {
    await dom.waitFor(`[data-pane-row^="dev:${NODE_MAC}:"]`);
    await dom.sleep(300);
  },
};
export default s;
