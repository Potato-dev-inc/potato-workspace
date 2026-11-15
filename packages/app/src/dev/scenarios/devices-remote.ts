import { MAC_MINI, MAC_PANES, NODE_MAC } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// A chat on the Mac mini, open in the main area: at the top the two lines that matter: Claude is
// signed out there (with the hint), and a password box is waiting for a person at the Mac.
const s: HarnessScenario = {
  name: 'devices-remote',
  route: 'cockpit',
  window: { width: 1280, height: 900 },
  devices: {
    devices: [{ ...MAC_MINI, signed_out: ['claude'], needs_person: [{ pane: 'p1', what: 'a password box is open there' }] }],
    panes: { [NODE_MAC]: MAC_PANES },
  },
  after: async (dom) => {
    await dom.waitFor(`[data-pane-row="dev:${NODE_MAC}:p1"]`);
    await dom.click(`[data-pane-row="dev:${NODE_MAC}:p1"]`);
    await dom.waitFor('[data-testid="remote-pane"]');
    await dom.sleep(400);
  },
};
export default s;
