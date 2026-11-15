import { MAC_MINI, MAC_PANES, NODE_MAC } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// A terminal on the Mac mini, open in the main area: the live screen (the far side pushes it), and the line that a password box waits for a person there.
const s: HarnessScenario = {
  name: 'devices-terminal',
  route: 'cockpit',
  window: { width: 1280, height: 900 },
  devices: {
    devices: [{ ...MAC_MINI, needs_person: [{ pane: 'p2', what: 'a password box is open there' }] }],
    panes: { [NODE_MAC]: MAC_PANES },
    screen: '$ make dmg\nBuilding Potato.app...\nSigning needs the keychain.',
  },
  after: async (dom) => {
    await dom.waitFor(`[data-pane-row="dev:${NODE_MAC}:p2"]`);
    await dom.click(`[data-pane-row="dev:${NODE_MAC}:p2"]`);
    await dom.waitFor('[data-testid="remote-screen"]');
    await dom.sleep(400);
  },
};
export default s;
