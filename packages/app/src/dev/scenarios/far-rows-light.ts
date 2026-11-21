import { MAC_MINI, NODE_MAC, PM_NIGHT_PANES } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// P2.4: another PC's project in the one Projects list, drawn by the same row code as this PC's: its chats called by name (not "opencode"),
// the helper under its front with the "N helpers" chip and the Workflow row, a chat on a copy, no standby or minion row. (light)
const s: HarnessScenario = {
  name: 'far-rows-light',
  route: 'cockpit',
  theme: 'light',
  workflows: true,
  window: { width: 1280, height: 1250 },
  devices: { devices: [MAC_MINI], panes: { [NODE_MAC]: PM_NIGHT_PANES } },
  after: async (dom) => {
    await dom.waitFor(`[data-pane-row^="dev:${NODE_MAC}:"]`);
    await dom.sleep(600);
  },
};
export default s;
