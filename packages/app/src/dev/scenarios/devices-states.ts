import { MAC_MINI, MAC_PANES, NODE_DESK, NODE_LAPTOP, NODE_MAC, WORK_LAPTOP } from '../devices-fixtures';
import type { HarnessScenario } from '../types';

// The sidebar with three devices that are not fine: the Mac mini fell asleep, the work laptop closed the app, and the Studio PC
// needs a person at its own screen. Each group says one word and one plain sentence; the first two keep their rows, greyed.
const STUDIO = { ...MAC_MINI, node: NODE_DESK, name: 'Studio PC', needs_person: [{ pane: 'p1', what: 'a password box is open there' }] };
const s: HarnessScenario = {
  name: 'devices-states',
  route: 'cockpit',
  window: { width: 1280, height: 900 },
  devices: {
    devices: [MAC_MINI, { ...WORK_LAPTOP, state: 'online', path: 'relay', last_seen: Math.floor(Date.now() / 1000) }, STUDIO],
    panes: { [NODE_MAC]: MAC_PANES, [NODE_LAPTOP]: MAC_PANES, [NODE_DESK]: MAC_PANES },
    changeAfter: [
      { ms: 1500, node: NODE_MAC, patch: { state: 'asleep', path: null } },
      { ms: 1500, node: NODE_LAPTOP, patch: { state: 'closed', path: null } },
    ],
  },
  after: async (dom) => {
    await dom.waitFor(`[data-remote-node="${NODE_MAC}"][data-state="asleep"]`, 8000);
    await dom.waitFor(`[data-remote-node="${NODE_LAPTOP}"][data-state="closed"]`, 8000);
    await dom.sleep(300);
  },
};
export default s;
